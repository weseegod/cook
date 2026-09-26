//! Resume re-park of the `exit_plan_mode` approval and the mid-turn disconnect handling.
//!
//! On resume the shell re-issues the `x.ai/exit_plan_mode` reverse-request when `awaiting_plan_approval` was persisted.
//! That recreates a live waiter, so the pager's existing approve/revise/abandon path works unchanged.
//! These tests pin the reverse-request shape, when the awaiting bit is set and cleared, and the mid-turn disconnect path.
//! A graceful client disconnect must NOT auto-approve.

use super::support::*;
use super::*;

const VALID_REVIEW_PLAN: &str = "# Plan: Ship a complete reusable widget\n\n## Goal kind\ncode-change\n\n## Decisions\n- Keep the existing API.\n\n## Context\n- The widget exists.\n- The API has callers.\n- The tests are local.\n\n## Acceptance criteria\n1. The widget works.\n\n## Verification plan\n1. gating: run `cargo test` and observe success.\n\n## Non-goals\n- New APIs.\n\n## Assumed scope\n- `src/widget.rs`\n\n## Implementation approach\nUse the existing module.\n\n## Current anchors\n- `src/widget.rs` `render_widget` observed: renders the widget and returns a string.\n- `tests/widget.rs` `new:widget_tests` observed: test file does not exist yet.\n\n## Edit brief\n### `src/widget.rs`\n- Now: `render_widget` returns a fixed string.\n- Change: Update the return value to match the new behavior.\n- Keep: Existing public API unchanged.\n- Proof: `cargo test widget`\n\n### `src/widget.rs`\n- Now: Callers use the old output.\n- Change: Integrate the new behavior with callers.\n- Keep: No caller breaks.\n- Proof: `cargo test widget`\n\n### `tests/widget.rs`\n- Now: No widget tests exist.\n- Change: Add tests for the new behavior.\n- Keep: Tests drive the real widget.\n- Proof: `cargo test widget`\n\n## Task checklist\n- [ ] `src/widget.rs` — update behavior. Done when: output changes.\n- [ ] `src/widget.rs` — integrate behavior. Done when: callers work.\n- [ ] `tests/widget.rs` — test the behavior. Done when: tests pass.\n\n## Deviations\n(none yet)\n";

#[tokio::test(flavor = "current_thread")]
async fn clean_handoff_keeps_one_plan_anchor_in_model_history() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _gateway_rx, _persistence_rx) = actor_with_channels().await;
            actor
                .chat_state_handle
                .push_user_message(ConversationItem::user("old exploration"));
            actor.handoff_plan_context(None).await;
            let history = actor.chat_state_handle.get_conversation().await;
            assert_eq!(history.len(), 1);
            assert!(
                history[0]
                    .text_content()
                    .contains("Implement the approved plan at")
            );
            assert!(
                history[0].text_content().contains("Current anchors"),
                "anchor must name ## Current anchors"
            );
            assert!(
                history[0].text_content().contains("Edit brief"),
                "anchor must name ## Edit brief"
            );
            assert!(!history[0].text_content().contains("old exploration"));
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn clean_handoff_keeps_system_and_project_instructions_prefix() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _gateway_rx, _persistence_rx) = actor_with_channels().await;
            let sys = ConversationItem::system("You are Grok.");
            let mut project = ConversationItem::user("## From: /repo/AGENTS.md\nfollow these rules");
            if let ConversationItem::User(u) = &mut project {
                u.synthetic_reason = xai_grok_sampling_types::SyntheticReason::ProjectInstructions;
            }
            actor
                .chat_state_handle
                .replace_conversation(vec![
                    sys.clone(),
                    project.clone(),
                    ConversationItem::user("plan the feature"),
                    ConversationItem::assistant("here is a plan"),
                ]);
            actor.handoff_plan_context(None).await;
            let history = actor.chat_state_handle.get_conversation().await;
            assert_eq!(history.len(), 3, "system + project instructions + anchor");
            assert!(matches!(history[0], ConversationItem::System(_)));
            assert!(matches!(
                history[1],
                ConversationItem::User(ref u)
                    if u.synthetic_reason == xai_grok_sampling_types::SyntheticReason::ProjectInstructions
            ));
            assert!(
                history[2]
                    .text_content()
                    .contains("Implement the approved plan at")
            );
            let joined = history
                .iter()
                .map(|i| i.text_content())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(!joined.contains("plan the feature"));
            assert!(!joined.contains("here is a plan"));
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn clean_handoff_drops_planning_tail_without_system() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _gateway_rx, _persistence_rx) = actor_with_channels().await;
            actor
                .chat_state_handle
                .replace_conversation(vec![
                    ConversationItem::user("plan the feature"),
                    ConversationItem::assistant("here is a plan"),
                ]);
            actor.handoff_plan_context(None).await;
            let history = actor.chat_state_handle.get_conversation().await;
            assert_eq!(history.len(), 1);
            assert!(
                history[0]
                    .text_content()
                    .contains("Implement the approved plan at")
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn clean_handoff_anchor_names_published_plan_path() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _gateway_rx, _persistence_rx) = actor_with_channels().await;
            let dir = tempfile::tempdir().unwrap();
            {
                let mut tracker = actor.plan_mode.lock();
                *tracker =
                    crate::session::plan_mode::PlanModeTracker::new(dir.path().to_path_buf());
                tracker.activate_from_tool();
                std::fs::write(tracker.plan_file_path(), VALID_REVIEW_PLAN).unwrap();
                assert!(tracker.deactivate_approved());
            }
            let published = actor.plan_mode.lock().plan_file_path().to_path_buf();
            assert!(
                published.exists(),
                "published plan path must exist on disk"
            );
            actor.handoff_plan_context(None).await;
            let history = actor.chat_state_handle.get_conversation().await;
            let anchor = history
                .last()
                .expect("anchor user item")
                .text_content();
            assert!(
                anchor.contains(&published.display().to_string()),
                "anchor must name the published path, got {anchor}"
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn clean_handoff_resets_context_tokens_used() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _gateway_rx, _persistence_rx) = actor_with_channels().await;
            actor.signals_handle().update_context_usage(250_000, 256_000);
            let before = actor.signals_handle().snapshot().await.unwrap();
            assert_eq!(before.context_tokens_used, 250_000);

            actor
                .chat_state_handle
                .push_user_message(ConversationItem::user("old exploration"));
            actor.handoff_plan_context(None).await;

            let after = actor.signals_handle().snapshot().await.unwrap();
            assert!(
                after.context_tokens_used < 250_000,
                "clean handoff must drop context_tokens_used, got {}",
                after.context_tokens_used
            );
        })
        .await;
}

/// Build the typed approval response the pager would send back.
fn ext_response(outcome: &str) -> Arc<serde_json::value::RawValue> {
    serde_json::value::to_raw_value(&serde_json::json!({ "outcome": outcome }))
        .unwrap()
        .into()
}

/// Actor with both gateway and persistence receivers retained (the shared `build_actor` drops persistence).
async fn actor_with_channels() -> (
    std::sync::Arc<SessionActor>,
    tokio::sync::mpsc::UnboundedReceiver<xai_acp_lib::AcpClientMessage>,
    tokio::sync::mpsc::UnboundedReceiver<PersistenceMsg>,
) {
    let (gateway_tx, gateway_rx) = tokio::sync::mpsc::unbounded_channel();
    let (persistence_tx, persistence_rx) = tokio::sync::mpsc::unbounded_channel();
    let (actor, _ev) = create_test_actor_ex(0, 256_000, 85, gateway_tx, persistence_tx).await;
    (std::sync::Arc::new(actor), gateway_rx, persistence_rx)
}

/// Latest persisted `awaiting_plan_approval` value, or `None` if plan-mode state was never persisted.
fn last_persisted_awaiting(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<PersistenceMsg>,
) -> Option<bool> {
    let mut last = None;
    while let Ok(msg) = rx.try_recv() {
        if let PersistenceMsg::PlanModeState(snapshot) = msg {
            last = Some(snapshot.awaiting_plan_approval);
        }
    }
    last
}

#[tokio::test(flavor = "current_thread")]
async fn request_plan_approval_issues_reverse_request_and_clears_flag() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, mut gateway_rx) = build_actor().await;

            // Stand in for the pager: answer the exit_plan_mode reverse-request with "approved"; ack the fire-and-forget pending broadcasts
            let responder = tokio::task::spawn_local(async move {
                let mut seen_method = None;
                let mut seen_session = None;
                while let Some(msg) = gateway_rx.recv().await {
                    match msg {
                        xai_acp_lib::AcpClientMessage::ExtMethod(args) => {
                            seen_method = Some(args.request.method.to_string());
                            let req: serde_json::Value =
                                serde_json::from_str(args.request.params.get()).unwrap();
                            seen_session = req
                                .get("sessionId")
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let _ = args
                                .response_tx
                                .send(Ok(acp::ExtResponse::new(ext_response("approved"))));
                            break;
                        }
                        xai_acp_lib::AcpClientMessage::SessionNotification(args) => {
                            let _ = args.response_tx.send(Ok(()));
                        }
                        _ => {}
                    }
                }
                (seen_method, seen_session)
            });

            let tool_call_id = acp::ToolCallId::new(Arc::from("tc-resume"));
            let parsed = actor
                .request_plan_approval(&tool_call_id, Some("# Plan".into()))
                .await
                .expect("approval round-trip should succeed");

            assert_eq!(parsed.outcome, "approved");
            assert!(
                !actor.plan_mode.lock().is_awaiting_plan_approval(),
                "awaiting flag must clear once the approval is answered"
            );

            let (method, session_id) = responder.await.unwrap();
            assert_eq!(method.as_deref(), Some("x.ai/exit_plan_mode"));
            assert_eq!(
                session_id.as_deref(),
                Some("test-actor"),
                "reverse-request must carry a non-empty sessionId (design §5.4)"
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn request_plan_approval_clears_flag_on_request_changes() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, mut gateway_rx) = build_actor().await;

            let responder = tokio::task::spawn_local(async move {
                while let Some(msg) = gateway_rx.recv().await {
                    match msg {
                        xai_acp_lib::AcpClientMessage::ExtMethod(args) => {
                            let _ = args
                                .response_tx
                                .send(Ok(acp::ExtResponse::new(ext_response("cancelled"))));
                            break;
                        }
                        xai_acp_lib::AcpClientMessage::SessionNotification(args) => {
                            let _ = args.response_tx.send(Ok(()));
                        }
                        _ => {}
                    }
                }
            });

            let tool_call_id = acp::ToolCallId::new(Arc::from("tc-resume-revise"));
            let parsed = actor
                .request_plan_approval(&tool_call_id, Some("# Plan".into()))
                .await
                .expect("approval round-trip should succeed");

            assert_eq!(parsed.outcome, "cancelled");
            // Request-changes leaves plan mode active but never strands the bit.
            assert!(!actor.plan_mode.lock().is_awaiting_plan_approval());
            responder.await.unwrap();
        })
        .await;
}

/// An unparseable approval response must fail CLOSED to `"cancelled"` (stay in plan mode), never fall open to `"approved"`.
#[tokio::test(flavor = "current_thread")]
async fn request_plan_approval_parse_fallback_fails_closed() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, mut gateway_rx) = build_actor().await;

            let responder = tokio::task::spawn_local(async move {
                while let Some(msg) = gateway_rx.recv().await {
                    match msg {
                        xai_acp_lib::AcpClientMessage::ExtMethod(args) => {
                            // Garbage payload that does not deserialize to ExitPlanModeExtResponse.
                            let garbage: Arc<serde_json::value::RawValue> =
                                serde_json::value::to_raw_value(&serde_json::json!(
                                    "not-an-object"
                                ))
                                .unwrap()
                                .into();
                            let _ = args.response_tx.send(Ok(acp::ExtResponse::new(garbage)));
                            break;
                        }
                        xai_acp_lib::AcpClientMessage::SessionNotification(args) => {
                            let _ = args.response_tx.send(Ok(()));
                        }
                        _ => {}
                    }
                }
            });

            let tool_call_id = acp::ToolCallId::new(Arc::from("tc-garbage"));
            let parsed = actor
                .request_plan_approval(&tool_call_id, Some("# Plan".into()))
                .await
                .expect("round-trip returns Ok even for a garbage payload");
            assert_eq!(parsed.outcome, "cancelled");
            responder.await.unwrap();
        })
        .await;
}

/// REAL park (not seeded): drive a genuine `exit_plan_mode` call through `prepare_tool_call` and simulate a client disconnect mid-approval.
/// The tool must NOT auto-execute and plan mode stays Active.
/// `awaiting_plan_approval=true` is PERSISTED (what would land in `plan_mode.json`) so a fresh resume re-parks.
#[tokio::test(flavor = "current_thread")]
async fn real_exit_plan_mode_disconnect_keeps_awaiting_persisted() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, mut gateway_rx, mut persistence_rx) = actor_with_channels().await;
            // Real enter/exit_plan_mode tools so prepare_tool_call parses a genuine call.
            *actor.agent.borrow_mut() = test_agent_with_plan_tools().await;
            // Plan mode Active with a real plan.md at the tracker path.
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("plan.md"), VALID_REVIEW_PLAN).unwrap();
            {
                let mut tracker = actor.plan_mode.lock();
                *tracker =
                    crate::session::plan_mode::PlanModeTracker::new(dir.path().to_path_buf());
                tracker.activate_from_tool();
            }

            // Pager receives the gate then disconnects (drops the request).
            let responder = tokio::task::spawn_local(async move {
                while let Some(msg) = gateway_rx.recv().await {
                    match msg {
                        xai_acp_lib::AcpClientMessage::ExtMethod(args) => {
                            drop(args); // No response, so the waiter sees "unable to receive response"
                            break;
                        }
                        xai_acp_lib::AcpClientMessage::SessionNotification(args) => {
                            let _ = args.response_tx.send(Ok(()));
                        }
                        _ => {}
                    }
                }
            });

            let call = crate::sampling::types::ToolCallResponse {
                id: "call-exit".to_string(),
                kind: "function".to_string(),
                function: crate::sampling::types::ToolCallFunction::new("exit_plan_mode", "{}"),
            };
            let mut deferred = Vec::new();
            let outcome = actor
                .prepare_tool_call(call, &mut deferred, None)
                .await
                .expect("prepare_tool_call should not error");

            // Disconnect must NOT auto-approve: the tool is not prepared/executed.
            match outcome {
                Err(ToolLoop::Cancelled) => {}
                other => panic!("expected ToolLoop::Cancelled on disconnect, got {other:?}"),
            }
            assert!(
                actor.plan_mode.lock().is_active(),
                "plan mode must remain Active after a disconnect (no auto-approve)"
            );
            assert!(
                actor.plan_mode.lock().is_awaiting_plan_approval(),
                "awaiting flag must remain set after a disconnect"
            );
            assert_eq!(
                last_persisted_awaiting(&mut persistence_rx),
                Some(true),
                "plan_mode.json must persist awaiting_plan_approval=true after disconnect"
            );
            responder.await.unwrap();
        })
        .await;
}

/// Headless, no UI client wired: the reverse-request can't be delivered, so `exit_plan_mode` falls through and executes (original behavior).
/// The proof is `prepare_tool_call` returning a prepared call rather than Cancelled.
#[tokio::test(flavor = "current_thread")]
async fn real_exit_plan_mode_no_client_executes_tool() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, gateway_rx, _persistence_rx) = actor_with_channels().await;
            // Drop the gateway receiver: the reverse-request enqueue fails ("unable to send"), the headless branch
            drop(gateway_rx);
            *actor.agent.borrow_mut() = test_agent_with_plan_tools().await;
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("plan.md"), VALID_REVIEW_PLAN).unwrap();
            {
                let mut tracker = actor.plan_mode.lock();
                *tracker =
                    crate::session::plan_mode::PlanModeTracker::new(dir.path().to_path_buf());
                tracker.activate_from_tool();
            }

            let call = crate::sampling::types::ToolCallResponse {
                id: "call-exit-headless".to_string(),
                kind: "function".to_string(),
                function: crate::sampling::types::ToolCallFunction::new("exit_plan_mode", "{}"),
            };
            let mut deferred = Vec::new();
            let outcome = actor
                .prepare_tool_call(call, &mut deferred, None)
                .await
                .expect("prepare_tool_call should not error");
            // Headless: the tool is prepared (it will execute and exit plan mode).
            assert!(
                outcome.is_ok(),
                "headless exit_plan_mode should fall through to execute the tool"
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn incomplete_plan_does_not_open_review() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, mut gateway_rx, _persistence_rx) = actor_with_channels().await;
            *actor.agent.borrow_mut() = test_agent_with_plan_tools().await;
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(
                dir.path().join("plan.md"),
                "# Plan: Only a title exists here now\n",
            )
            .unwrap();
            {
                let mut tracker = actor.plan_mode.lock();
                *tracker =
                    crate::session::plan_mode::PlanModeTracker::new(dir.path().to_path_buf());
                tracker.activate_from_tool();
            }
            let call = crate::sampling::types::ToolCallResponse {
                id: "call-incomplete-plan".into(),
                kind: "function".into(),
                function: crate::sampling::types::ToolCallFunction::new("exit_plan_mode", "{}"),
            };
            let mut deferred = Vec::new();
            let outcome = actor
                .prepare_tool_call(call, &mut deferred, None)
                .await
                .unwrap();
            assert!(matches!(outcome, Err(ToolLoop::Continue)));
            assert!(actor.plan_mode.lock().is_active());
            while let Ok(message) = gateway_rx.try_recv() {
                assert!(!matches!(
                    message,
                    xai_acp_lib::AcpClientMessage::ExtMethod(_)
                ));
            }
        })
        .await;
}

/// Quitting while the approval is parked (a disconnect) keeps `awaiting_plan_approval` set so the next resume re-parks the gate.
/// Not seeded: `request_plan_approval` sets the bit itself.
#[tokio::test(flavor = "current_thread")]
async fn request_plan_approval_keeps_flag_when_client_disconnects() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, mut gateway_rx, mut persistence_rx) = actor_with_channels().await;

            let responder = tokio::task::spawn_local(async move {
                while let Some(msg) = gateway_rx.recv().await {
                    match msg {
                        xai_acp_lib::AcpClientMessage::ExtMethod(args) => {
                            drop(args); // No response, so ext_method sees Err
                            break;
                        }
                        xai_acp_lib::AcpClientMessage::SessionNotification(args) => {
                            let _ = args.response_tx.send(Ok(()));
                        }
                        _ => {}
                    }
                }
            });

            let tool_call_id = acp::ToolCallId::new(Arc::from("tc-resume-quit"));
            let result = actor
                .request_plan_approval(&tool_call_id, Some("# Plan".into()))
                .await;

            assert!(result.is_err(), "disconnect should surface as an error");
            assert!(
                actor.plan_mode.lock().is_awaiting_plan_approval(),
                "awaiting flag must survive a client disconnect"
            );
            assert_eq!(
                last_persisted_awaiting(&mut persistence_rx),
                Some(true),
                "the parked approval must be persisted as awaiting=true"
            );
            responder.await.unwrap();
        })
        .await;
}

/// Dropping the `request_plan_approval` future mid-await (the turn-cancel path) must clear the awaiting bit via `AwaitingApprovalGuard`.
#[tokio::test(flavor = "current_thread")]
async fn request_plan_approval_future_drop_clears_flag() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, mut gateway_rx) = build_actor().await;

            // Pager receives the request but never answers (keeps the parked await pending) so we can drop the future while it is in flight
            let responder = tokio::task::spawn_local(async move {
                while let Some(msg) = gateway_rx.recv().await {
                    match msg {
                        xai_acp_lib::AcpClientMessage::ExtMethod(args) => {
                            // Hold the response sender open: never resolve.
                            std::mem::forget(args);
                            break;
                        }
                        xai_acp_lib::AcpClientMessage::SessionNotification(args) => {
                            let _ = args.response_tx.send(Ok(()));
                        }
                        _ => {}
                    }
                }
            });

            let tool_call_id = acp::ToolCallId::new(Arc::from("tc-drop"));
            let mut fut =
                Box::pin(actor.request_plan_approval(&tool_call_id, Some("# Plan".into())));
            // Poll until the request is parked (awaiting flag set), then drop.
            tokio::select! {
                _ = &mut fut => panic!("request should still be parked (no answer)"),
                _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
            }
            assert!(actor.plan_mode.lock().is_awaiting_plan_approval());
            drop(fut); // Turn cancelled, so the guard runs

            assert!(
                !actor.plan_mode.lock().is_awaiting_plan_approval(),
                "dropping the parked future must clear the awaiting bit"
            );
            responder.abort();
        })
        .await;
}

/// Resume with the flag set but no `plan.md` on disk: clear the bit and issue NO reverse-request.
#[tokio::test(flavor = "current_thread")]
async fn resume_no_plan_md_clears_flag_without_request() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, mut gateway_rx, _persistence_rx) = actor_with_channels().await;
            // Point the tracker at an empty dir (no plan.md) and set the flag
            let dir = tempfile::tempdir().unwrap();
            {
                let mut tracker = actor.plan_mode.lock();
                *tracker =
                    crate::session::plan_mode::PlanModeTracker::new(dir.path().to_path_buf());
                tracker.activate_from_tool();
                tracker.set_awaiting_plan_approval(true);
            }

            let (completion_tx, _completion_rx) = tokio::sync::mpsc::unbounded_channel();
            actor.clone().resume_plan_approval(completion_tx).await;

            assert!(
                !actor.plan_mode.lock().is_awaiting_plan_approval(),
                "missing plan.md must clear the stuck awaiting bit"
            );
            assert!(
                gateway_rx.try_recv().is_err(),
                "no reverse-request should be sent when plan.md is missing"
            );
        })
        .await;
}

/// `approved_as_goal` on the resume re-park: leave plan mode, seed a goal
/// with the approved plan body, and queue the goal-reminder turn instead of
/// an implement turn.
#[tokio::test(flavor = "current_thread")]
async fn resume_approved_as_goal_seeds_goal_with_plan() {
    const PLAN_FOR_GOAL: &str = VALID_REVIEW_PLAN;
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (gateway_tx, mut gateway_rx) = tokio::sync::mpsc::unbounded_channel();
            let (persistence_tx, _persistence_rx) = tokio::sync::mpsc::unbounded_channel();
            // Mutate goal harness before the Arc wrap (matching
            // `make_planner_actor`): the resume path seeds the goal with the
            // approved plan body.
            let (mut actor, _ev) =
                create_test_actor_ex(0, 256_000, 85, gateway_tx, persistence_tx).await;

            let plan_dir = tempfile::tempdir().unwrap();
            std::fs::write(plan_dir.path().join("plan.md"), PLAN_FOR_GOAL).unwrap();
            {
                let mut tracker = actor.plan_mode.lock();
                *tracker =
                    crate::session::plan_mode::PlanModeTracker::new(plan_dir.path().to_path_buf());
                tracker.activate_from_tool();
                tracker.set_awaiting_plan_approval(true);
            }

            let goal_dir = tempfile::tempdir().unwrap();
            actor.goal_enabled = true;
            set_goal_harness_for_tests(&actor);
            actor.goal_tracker = std::sync::Arc::new(parking_lot::Mutex::new(
                crate::session::goal_tracker::GoalTracker::new(goal_dir.path().to_path_buf()),
            ));
            let actor = std::sync::Arc::new(actor);

            // Stand in for the pager: answer the exit_plan_mode re-park with
            // the goal outcome; ack fire-and-forget broadcasts.
            let responder = tokio::task::spawn_local(async move {
                while let Some(msg) = gateway_rx.recv().await {
                    match msg {
                        xai_acp_lib::AcpClientMessage::ExtMethod(args) => {
                            let _ = args
                                .response_tx
                                .send(Ok(acp::ExtResponse::new(ext_response("approved_as_goal"))));
                            break;
                        }
                        xai_acp_lib::AcpClientMessage::SessionNotification(args) => {
                            let _ = args.response_tx.send(Ok(()));
                        }
                        _ => {}
                    }
                }
            });

            let (completion_tx, _completion_rx) = tokio::sync::mpsc::unbounded_channel();
            actor.clone().resume_plan_approval(completion_tx).await;

            assert!(
                !actor.plan_mode.lock().is_awaiting_plan_approval(),
                "approve-as-goal must clear the awaiting bit like approve"
            );
            let snap = actor.goal_tracker.lock().snapshot().cloned().unwrap();
            assert!(snap.plan_contract_frozen);
            let plan_path = actor.goal_tracker.lock().plan_path();
            assert_eq!(
                snap.plan_file.as_deref(),
                Some(plan_path.as_path()),
                "goal must publish the user-approved plan"
            );
            assert_eq!(
                std::fs::read_to_string(&plan_path).unwrap(),
                PLAN_FOR_GOAL,
                "goal plan.md must carry the approved plan body"
            );
            assert_eq!(
                std::fs::read_to_string(actor.goal_tracker.lock().plan_baseline_path()).unwrap(),
                PLAN_FOR_GOAL,
                "baseline must snapshot the identical body"
            );
            assert_eq!(
                snap.objective, "Ship a complete reusable widget",
                "objective derives from the plan title"
            );

            responder.await.unwrap();
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn resume_approved_clean_freezes_plan_and_restarts_from_anchor() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, mut gateway_rx, _persistence_rx) = actor_with_channels().await;
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("plan.md"), VALID_REVIEW_PLAN).unwrap();
            {
                let mut tracker = actor.plan_mode.lock();
                *tracker =
                    crate::session::plan_mode::PlanModeTracker::new(dir.path().to_path_buf());
                tracker.activate_from_tool();
                tracker.set_awaiting_plan_approval(true);
            }
            let responder = tokio::task::spawn_local(async move {
                while let Some(msg) = gateway_rx.recv().await {
                    match msg {
                        xai_acp_lib::AcpClientMessage::ExtMethod(args) => {
                            let _ = args
                                .response_tx
                                .send(Ok(acp::ExtResponse::new(ext_response("approved_clean"))));
                            break;
                        }
                        xai_acp_lib::AcpClientMessage::SessionNotification(args) => {
                            let _ = args.response_tx.send(Ok(()));
                        }
                        _ => {}
                    }
                }
            });
            let (completion_tx, _completion_rx) = tokio::sync::mpsc::unbounded_channel();
            actor.clone().resume_plan_approval(completion_tx).await;
            let frozen = actor.plan_mode.lock().frozen_plan().unwrap().clone();
            assert_eq!(
                std::fs::read_to_string(&frozen.episode).unwrap(),
                VALID_REVIEW_PLAN
            );
            assert_eq!(
                std::fs::read_to_string(&frozen.baseline).unwrap(),
                VALID_REVIEW_PLAN
            );
            assert!(!actor.plan_mode.lock().is_active());
            responder.await.unwrap();
        })
        .await;
}
