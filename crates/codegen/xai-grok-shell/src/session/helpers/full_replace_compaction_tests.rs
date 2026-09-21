use super::*;
use crate::session::helpers::prepared_compaction_history::build_compaction_chat_history;

#[test]
fn compact_failure_maps_onto_engine_error_classes() {
    let err = |msg: &str| acp::Error::internal_error().data(msg.to_string());

    // Overflow → ContextOverflow with the message preserved, so the flag
    // doesn't depend on message text.
    let mapped = compact_failure_to_sample_error(CompactFailure::Overflow(err(
        "compact failed: API error (status 413 Payload Too Large): Request failed (HTTP 413).",
    )));
    assert!(matches!(&mapped, CompactionSampleError::ContextOverflow(m)
        if m.contains("HTTP 413")));
    assert!(mapped.is_deterministic());

    let mapped =
        compact_failure_to_sample_error(CompactFailure::Deterministic(err("compact failed: 400")));
    assert!(matches!(&mapped, CompactionSampleError::Build(_)));

    let mapped =
        compact_failure_to_sample_error(CompactFailure::Transient(err("compact failed: blip")));
    assert!(matches!(&mapped, CompactionSampleError::Other(_)));
    assert!(!mapped.is_deterministic());
}

#[test]
fn sampler_state_keeps_exact_latest_prepared_items() {
    let mut state = SamplerState::default();
    let first = build_compaction_chat_history(vec![ConversationItem::user("first")], None, true, 0);
    let second =
        build_compaction_chat_history(vec![ConversationItem::user("second")], None, true, 0);
    state.record_attempt(&first);
    state.record_attempt(&second);

    assert_eq!(
        serde_json::to_value(state.last_attempted_items.unwrap()).unwrap(),
        serde_json::to_value(second.items).unwrap()
    );
}

#[test]
fn acp_error_message_reads_string_and_object_shaped_data() {
    let string_err = acp::Error::internal_error().data("compact failed: boom");
    assert_eq!(
        crate::sampling::error::acp_error_message(&string_err),
        "compact failed: boom"
    );
    let object_err = acp::Error::internal_error()
        .data(serde_json::json!({"kind": "compact_cancelled", "message": "compact cancelled"}));
    assert_eq!(
        crate::sampling::error::acp_error_message(&object_err),
        "compact cancelled"
    );
    let no_data = acp::Error::internal_error();
    assert_eq!(
        crate::sampling::error::acp_error_message(&no_data),
        "Internal error"
    );
}

/// The single-pass compaction path must fold its provider usage into the session
/// ledger under `compact_single`, and must not add a turn. End to end through the
/// real sampler, a real chat-state actor, and a real SSE response.
#[tokio::test]
async fn single_pass_sampler_folds_usage_into_the_session_ledger() {
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
                        "model": "test-model",
                        "choices": [{
                            "index": 0,
                            "delta": { "role": "assistant", "content": "<summary>ok</summary>" },
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
                        "model": "test-model",
                        "choices": [],
                        "usage": {
                            "prompt_tokens": 4_000,
                            "completion_tokens": 250,
                            "total_tokens": 4_250,
                            "cost_in_usd_ticks": 9
                        }
                    })
                    .to_string(),
                ),
                Event::default().data("[DONE]"),
            ];
            let stream = stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
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
    let chat_state_handle = xai_chat_state::ChatStateActor::spawn(
        vec![],
        xai_grok_sampling_types::SamplingConfig {
            base_url: format!("http://{addr}/v1"),
            model: "test-model".to_string(),
            context_window: std::num::NonZeroU64::new(256_000).unwrap(),
            ..Default::default()
        },
        Box::new(xai_chat_state::NullChatPersistence),
        chat_event_tx,
        tokio_util::sync::CancellationToken::new(),
    );

    let sampling_config = xai_grok_sampler::SamplerConfig {
        base_url: format!("http://{addr}/v1"),
        api_key: Some("test-api-key".to_string()),
        model: "test-model".to_string(),
        context_window: 256_000,
        ..Default::default()
    };
    let client = crate::sampling::Client::new(sampling_config.clone()).unwrap();
    let sampler = ShellCompactionSampler::new(
        true,
        None,
        vec![],
        vec![],
        0,
        client,
        acp::SessionId::new("test-session"),
        sampling_config,
        true,
        Duration::from_secs(30),
        0,
        crate::util::config::CompactionToolChoice::Auto,
        tokio_util::sync::CancellationToken::new(),
        chat_state_handle.clone(),
    );

    sampler
        .sample_compaction(
            &[ConversationItem::user("Summarize the conversation so far.")],
            &xai_grok_compaction::CompactionPrompt {
                system: String::new(),
                user: String::new(),
            },
            Duration::from_secs(30),
        )
        .await
        .expect("compaction sample succeeds");
    let _ = shutdown_tx.send(());

    let session = chat_state_handle
        .try_get_session_usage()
        .await
        .expect("session ledger");
    let single = session
        .by_purpose
        .get(&xai_chat_state::CallPurpose::CompactSingle)
        .expect("compaction recorded under its own purpose");
    assert_eq!(single.input_tokens, 4_000);
    assert_eq!(single.output_tokens, 250);
    assert_eq!(single.model_calls, 1);
    assert_eq!(session.side_call_model_calls, 1);
    assert_eq!(
        session.main_loop_model_calls, 0,
        "a compaction summary is not a turn"
    );
    assert_eq!(session.totals.cost_usd_ticks, Some(9));
}
