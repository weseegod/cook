mod acp_harness;

use acp_harness::{AutoApproveClient, RPC_TIMEOUT, connect_and_auth, new_session, prompt_turn};
use agent_client_protocol::{self as acp, Agent as _};
use serde_json::{Value, json};
use xai_grok_test_support::{
    InferenceEndpoint, InferenceRequestMatcher, MockModelEntry, ScriptedResponse, SseEvent,
};

fn tool_call(id: &str, name: &str, arguments: Value) -> ScriptedResponse {
    ScriptedResponse::sse(vec![
        SseEvent::data(
            json!({
                "id": "chatcmpl-budget", "object": "chat.completion.chunk", "created": 1,
                "model": "test-model", "choices": [{"index": 0, "delta": {
                    "role": "assistant", "tool_calls": [{"index": 0, "id": id, "type": "function",
                        "function": {"name": name, "arguments": arguments.to_string()}}]},
                    "finish_reason": null}]
            })
            .to_string(),
        ),
        SseEvent::data(
            json!({
                "id": "chatcmpl-budget", "object": "chat.completion.chunk", "created": 1,
                "model": "test-model", "choices": [{"index": 0, "delta": {},
                    "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
            })
            .to_string(),
        ),
        SseEvent::data("[DONE]"),
    ])
}

fn text_reply() -> ScriptedResponse {
    ScriptedResponse::sse(xai_grok_test_support::sse::chat_completion_script_exact(
        "done",
        "test-model",
    ))
}

fn foreground() -> InferenceRequestMatcher {
    InferenceRequestMatcher::foreground(InferenceEndpoint::ChatCompletions)
}

#[test]
fn oversized_call_recovers_and_executes_later_write_in_same_turn() {
    acp_harness::run_agent_test_with_models(
        vec![MockModelEntry::new("test-model").with_api_backend("chat_completions")],
        |cwd, server| async move {
            let path = cwd.join("app.js");
            let big = json!({"file_path": path, "content": "x".repeat(33_000)});
            let _first = server.expect_response(
                "oversized",
                foreground(),
                tool_call("call-big", "write", big),
            );
            let small = json!({"file_path": path, "content": "ok"});
            let _second = server.expect_response(
                "small-write",
                foreground(),
                tool_call("call-small", "write", small),
            );
            let _third = server.expect_response("finish", foreground(), text_reply());

            let (conn, _) = connect_and_auth(AutoApproveClient, "budget-recovery-check").await;
            let session_id = new_session(&conn, &cwd).await;
            prompt_turn(&conn, &session_id, "Create app.js").await;
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "ok\n");
            let requests: Vec<_> = server
                .requests()
                .into_iter()
                .filter(|r| r.path == "/v1/chat/completions")
                .filter(|r| {
                    !r.header("x-grok-req-id")
                        .is_some_and(|id| id.starts_with("xai-turn-summary-"))
                })
                .collect();
            assert!(
                requests.len() >= 3,
                "expected three main-loop requests, got {}",
                requests.len()
            );
            let feedback_request = requests
                .iter()
                .filter_map(|request| request.body.as_ref())
                .map(Value::to_string)
                .find(|body| body.contains("Split the write into smaller tool calls"))
                .expect("the continuation request must carry budget feedback");
            assert!(feedback_request.contains("bytes of arguments"));
        },
    );
}

#[test]
fn oversized_call_then_text_fails_without_file() {
    acp_harness::run_agent_test_with_models(
        vec![MockModelEntry::new("test-model").with_api_backend("chat_completions")],
        |cwd, server| async move {
            let path = cwd.join("app.js");
            let big = json!({"file_path": path, "content": "x".repeat(33_000)});
            let _first = server.expect_response(
                "oversized",
                foreground(),
                tool_call("call-big", "write", big),
            );
            let _second = server.expect_response("text-only", foreground(), text_reply());

            let (conn, _) = connect_and_auth(AutoApproveClient, "budget-recovery-check").await;
            let session_id = new_session(&conn, &cwd).await;
            let result = tokio::time::timeout(
                RPC_TIMEOUT,
                conn.prompt(acp::PromptRequest::new(
                    session_id,
                    vec![acp::ContentBlock::Text(acp::TextContent::new(
                        "Create app.js",
                    ))],
                )),
            )
            .await
            .expect("prompt timed out");
            assert!(
                result.is_err(),
                "a text-only continuation must fail the turn"
            );
            assert!(!path.exists());
        },
    );
}
