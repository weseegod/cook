//! The `x-opencode-session` header a session's requests carry: OpenCode Go rejects a request
//! without it, and one conversation must keep a single value so routing and prompt caching hold.

use super::support::*;
use super::*;

const OPENCODE_BASE_URL: &str = "https://opencode.ai/zen/go/v1";

async fn actor_talking_to_opencode(group: crate::sampling::ConversationGroupId) -> std::sync::Arc<SessionActor> {
    let (actor, _gateway_rx) = build_actor().await;
    let mut config = actor
        .chat_state_handle
        .get_sampling_config()
        .await
        .expect("test actor has sampling config");
    config.base_url = OPENCODE_BASE_URL.to_owned();
    config.conversation_group_id = Some(group);
    actor.chat_state_handle.update_sampling_config(config);
    actor
}

fn session_header(config: &xai_grok_sampler::SamplerConfig) -> Option<String> {
    config
        .extra_headers
        .get(crate::agent::config::OPENCODE_SESSION_HEADER)
        .cloned()
}

#[tokio::test(flavor = "current_thread")]
async fn reconstruct_reuses_one_opencode_session_id_per_conversation() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let group = crate::sampling::derive_conversation_group_id("session-a");
            let actor = actor_talking_to_opencode(group.clone()).await;
            let first = actor.reconstruct_full_config().await;
            let second = actor.reconstruct_full_config().await;
            assert_eq!(
                session_header(&first).as_deref(),
                Some(group.as_ref()),
                "the conversation's id must reach the request"
            );
            assert_eq!(
                session_header(&second),
                session_header(&first),
                "a later turn must reuse the conversation's id"
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn separate_conversations_send_separate_opencode_session_ids() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let first = actor_talking_to_opencode(crate::sampling::derive_conversation_group_id(
                "session-a",
            ))
            .await;
            let second = actor_talking_to_opencode(crate::sampling::derive_conversation_group_id(
                "session-b",
            ))
            .await;
            let first_header = session_header(&first.reconstruct_full_config().await);
            let second_header = session_header(&second.reconstruct_full_config().await);
            assert!(first_header.is_some(), "first conversation must send an id");
            assert!(second_header.is_some(), "second conversation must send an id");
            assert_ne!(
                first_header, second_header,
                "two conversations must not share one OpenCode session"
            );
        })
        .await;
}
