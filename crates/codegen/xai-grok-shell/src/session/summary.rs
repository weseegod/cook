//! Session summary (title) generation.
//!
//! Checks whether a summary exists, generates one via the LLM, persists it, syncs to remote, updates the session registry, and notifies the client.
//! The persistence actor just calls [`SummaryGenerator::update`]; all state transitions are internal.

use crate::extensions::notification::{SessionNotification, SessionUpdate as XaiSessionUpdate};
use crate::sampling::Client as OaiCompatClient;
use crate::session::helpers::session_summary::generate_session_summary;
use crate::session::info::Info;
use crate::session::persistence::PersistenceMsg;
use agent_client_protocol as acp;
use tokio::sync::mpsc;
use xai_acp_lib::AcpAgentGatewaySender as GatewaySender;

enum State {
    /// No summary generated yet. The next [`SummaryGenerator::update`] call will attempt one.
    Idle,
    /// Summary generation has been attempted (spawned or already on disk). No further work needed.
    Done,
}

pub(crate) struct SummaryConfig {
    pub(crate) sampling_client: OaiCompatClient,
    pub(crate) model: String,
    /// Channel back to the persistence actor for sequential storage writes.
    /// Weak: a strong sender here would keep the actor's own channel and task alive.
    pub(crate) persistence_tx: mpsc::WeakUnboundedSender<PersistenceMsg>,
    /// Late-bound ledger handle for the title call, filled by the session spawn once the
    /// chat-state actor exists. Stays empty on paths that never bind one, which just means
    /// the title call goes unaccounted instead of failing.
    pub(crate) chat_state: std::sync::Arc<std::sync::OnceLock<xai_chat_state::ChatStateHandle>>,
}

/// Created once per persistence actor. The only public method is [`update`], which is called from the `ContentChunk` handler.
pub(crate) struct SummaryGenerator {
    state: State,
    config: SummaryConfig,
}

impl SummaryGenerator {
    pub(crate) fn new(config: SummaryConfig) -> Self {
        Self {
            state: State::Idle,
            config,
        }
    }

    /// Generate a session summary from the first content chunk.
    /// Idle: checks disk for an existing summary, spawns a background task for LLM title generation so the persistence actor is not blocked.
    /// Empty content is skipped (stays Idle) so the next chunk can retry.
    pub(crate) fn update(&mut self, content: String) {
        match self.state {
            State::Done => {}
            State::Idle => {
                // No text to generate a title from (e.g. image-only message).
                // Stay Idle so the next ContentChunk with actual text retries.
                if content.trim().is_empty() {
                    return;
                }

                // Transition to Done so subsequent ContentChunk messages don't spawn duplicate title generation tasks
                self.state = State::Done;

                let sampling_client = self.config.sampling_client.clone();
                let model = self.config.model.clone();
                let persistence_tx = self.config.persistence_tx.clone();
                let chat_state = self.config.chat_state.get().cloned();

                // A background task runs the LLM call so the persistence actor keeps processing messages (updates, flushes)
                tokio::spawn(async move {
                    let mut title = generate_session_summary(
                        content.clone(),
                        sampling_client,
                        &model,
                        chat_state.as_ref(),
                    )
                    .await;
                    if title.trim().is_empty() {
                        title =
                            crate::session::helpers::session_summary::title_fallback_from_user_text(
                                &content,
                            );
                    }

                    // The actor persists the title (only if the session has no title yet) and notifies the client there
                    // If a manual `/rename` won the race, the actor rejects the generated title, so it never reaches the client
                    match persistence_tx.upgrade() {
                        Some(tx) => {
                            let _ = tx.send(PersistenceMsg::GeneratedTitle(title));
                        }
                        None => tracing::debug!("session closed before its title was generated"),
                    }
                });
            }
        }
    }

    /// Mark as Done (e.g. when disk already has a summary during load).
    pub(crate) fn mark_done(&mut self) {
        self.state = State::Done;
    }

    /// Inverse of [`mark_done`]: `/rename --auto` calls this so the next content chunk regenerates a title through the normal if-absent path.
    pub(crate) fn reset(&mut self) {
        self.state = State::Idle;
    }

    #[cfg(test)]
    pub(crate) fn is_idle(&self) -> bool {
        matches!(self.state, State::Idle)
    }
}

/// Notify the client that a session summary is available.
pub(crate) fn notify_client(gateway: &Option<GatewaySender>, info: &Info, title: &str) {
    let Some(gateway) = gateway else {
        return;
    };

    let notification = SessionNotification {
        session_id: info.id.clone(),
        update: XaiSessionUpdate::SessionSummaryGenerated {
            session_summary: title.to_owned(),
        },
        meta: None,
    };
    if let Ok(params) = serde_json::value::to_raw_value(&notification) {
        gateway.forward_fire_and_forget(acp::ExtNotification::new(
            "x.ai/session_notification",
            params.into(),
        ));
    }

    gateway.forward_fire_and_forget(session_info_update(info.id.clone(), title));
}

pub(crate) fn session_info_update(
    session_id: acp::SessionId,
    title: &str,
) -> acp::SessionNotification {
    // `updatedAt` is omitted, not refreshed: renaming is not activity, and `session/list` sorts on `last_active_at`, which a title write never moves
    acp::SessionNotification::new(
        session_id,
        acp::SessionUpdate::SessionInfoUpdate(
            acp::SessionInfoUpdate::new().title(title.to_owned()),
        ),
    )
}

/// Manual-rename fan-out: same payload as [`session_info_update`] plus `_meta.x.ai/titleIsManual`.
/// Old clients ignore the unknown key.
pub(crate) fn session_info_update_manual(
    session_id: acp::SessionId,
    title: &str,
) -> acp::SessionNotification {
    session_info_update(session_id, title).meta(
        crate::extensions::notification::title_is_manual_meta()
            .as_object()
            .cloned(),
    )
}

/// Unpin fan-out: no title (avoid blanking list-driven clients) plus `_meta.x.ai/titleIsManual: false`.
pub(crate) fn session_info_update_unpinned(session_id: acp::SessionId) -> acp::SessionNotification {
    acp::SessionNotification::new(
        session_id,
        acp::SessionUpdate::SessionInfoUpdate(acp::SessionInfoUpdate::new()),
    )
    .meta(
        crate::extensions::notification::title_is_unpinned_meta()
            .as_object()
            .cloned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_info_update_manual_carries_meta_and_raw_title() {
        let n = session_info_update_manual(acp::SessionId::new("s"), "a &amp; b");
        let v = serde_json::to_value(&n).unwrap();
        assert_eq!(
            v.get("_meta")
                .and_then(|m| m.get(crate::extensions::notification::TITLE_IS_MANUAL_META_KEY)),
            Some(&serde_json::Value::Bool(true))
        );
        let title = v
            .pointer("/update/title")
            .or_else(|| v.pointer("/update/sessionInfoUpdate/title"))
            .cloned();
        assert_eq!(title, Some(serde_json::json!("a &amp; b")), "{v}");
    }

    #[test]
    fn session_info_update_unpinned_stamps_false_meta_without_title() {
        let n = session_info_update_unpinned(acp::SessionId::new("s"));
        let v = serde_json::to_value(&n).unwrap();
        assert_eq!(
            v.get("_meta")
                .and_then(|m| m.get(crate::extensions::notification::TITLE_IS_MANUAL_META_KEY)),
            Some(&serde_json::Value::Bool(false))
        );
        let title = v
            .pointer("/update/title")
            .or_else(|| v.pointer("/update/sessionInfoUpdate/title"));
        assert!(
            title.is_none(),
            "unpin SessionInfoUpdate must omit title: {v}"
        );
    }

    #[test]
    fn auto_session_info_update_omits_manual_meta() {
        let n = session_info_update(acp::SessionId::new("s"), "Auto");
        let v = serde_json::to_value(&n).unwrap();
        assert!(
            v.get("_meta")
                .and_then(|m| m.get(crate::extensions::notification::TITLE_IS_MANUAL_META_KEY))
                .is_none(),
            "auto-title fan-out must not stamp titleIsManual: {v}"
        );
    }

    #[test]
    fn reset_returns_generator_to_idle() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let sampling_client =
            OaiCompatClient::new(xai_grok_sampler::SamplerConfig::default()).unwrap();
        let mut generator = SummaryGenerator::new(SummaryConfig {
            sampling_client,
            model: String::new(),
            persistence_tx: tx.downgrade(),
            chat_state: std::sync::Arc::new(std::sync::OnceLock::new()),
        });
        assert!(generator.is_idle());
        generator.mark_done();
        assert!(!generator.is_idle());
        generator.reset();
        assert!(generator.is_idle());
        generator.reset();
        assert!(generator.is_idle());
    }

    /// The generator reads the late-bound ledger handle at call time and folds the title call's
    /// usage into the session ledger. End to end through `update`, a real chat-state actor, and a
    /// real SSE response; the `GeneratedTitle` message orders the assertion after the ledger write.
    #[tokio::test]
    async fn update_folds_the_title_call_into_the_bound_ledger() {
        use axum::Router;
        use axum::response::sse::{Event, KeepAlive, Sse};
        use axum::routing::post;
        use futures_util::stream;
        use serde_json::json;
        use tokio::net::TcpListener;

        let app = Router::new().route(
            "/v1/chat/completions",
            post(|| async {
                let events = vec![
                    Event::default().data(
                        json!({
                            "id": "chatcmpl-test",
                            "object": "chat.completion.chunk",
                            "created": 1,
                            "model": "title-model",
                            "choices": [{
                                "index": 0,
                                "delta": { "role": "assistant", "content": "Fix the auth bug" },
                                "finish_reason": "stop"
                            }]
                        })
                        .to_string(),
                    ),
                    Event::default().data(
                        json!({
                            "id": "chatcmpl-test",
                            "object": "chat.completion.chunk",
                            "created": 1,
                            "model": "title-model",
                            "choices": [],
                            "usage": {
                                "prompt_tokens": 300,
                                "completion_tokens": 8,
                                "total_tokens": 308,
                                "cost_in_usd_ticks": 2
                            }
                        })
                        .to_string(),
                    ),
                    Event::default().data("[DONE]"),
                ];
                let stream =
                    stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
                Sse::new(stream).keep_alive(KeepAlive::default())
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .unwrap();
        });

        let (chat_event_tx, _chat_event_rx) = tokio::sync::mpsc::unbounded_channel();
        let chat_state = xai_chat_state::ChatStateActor::spawn(
            vec![],
            xai_grok_sampling_types::SamplingConfig::default(),
            Box::new(xai_chat_state::NullChatPersistence),
            chat_event_tx,
            tokio_util::sync::CancellationToken::new(),
        );
        let (persistence_tx, mut persistence_rx) = mpsc::unbounded_channel::<PersistenceMsg>();
        let cell = std::sync::Arc::new(std::sync::OnceLock::new());
        // Production binds the handle after the chat-state actor exists and reads the cell at call
        // time; bind before the first update so the ordering contract is exercised here too.
        assert!(cell.set(chat_state.clone()).is_ok());
        let mut generator = SummaryGenerator::new(SummaryConfig {
            sampling_client: OaiCompatClient::new(xai_grok_sampler::SamplerConfig {
                base_url: format!("http://{addr}/v1"),
                api_key: Some("test-api-key".to_string()),
                model: "title-model".to_string(),
                context_window: 256_000,
                ..Default::default()
            })
            .unwrap(),
            model: "title-model".to_string(),
            persistence_tx: persistence_tx.downgrade(),
            chat_state: cell,
        });

        generator.update("fix the auth bug in login.rs".to_string());
        let emitted =
            tokio::time::timeout(std::time::Duration::from_secs(10), persistence_rx.recv())
                .await
                .expect("title generation finishes")
                .expect("persistence channel open");
        let _ = shutdown_tx.send(());
        assert!(
            matches!(emitted, PersistenceMsg::GeneratedTitle(_)),
            "update must persist the generated title"
        );

        let session = chat_state
            .try_get_session_usage()
            .await
            .expect("session ledger");
        let title = session
            .by_purpose
            .get(&xai_chat_state::CallPurpose::SessionTitle)
            .expect("session title row");
        assert_eq!(title.input_tokens, 300);
        assert_eq!(title.output_tokens, 8);
        assert_eq!(title.model_calls, 1);
        assert_eq!(session.main_loop_model_calls, 0);
    }
}
