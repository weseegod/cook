//! OpenCode `todowrite` tool — full-replace task list management.
//!
//! Follows the opencode convention: every call sends the **complete** todo list
//! (full-replace semantics, no merge). Items carry `content`, `status`, and
//! `priority` — no caller-supplied IDs.
//!
//! State is stored as `State<TodoState>` in Resources, shared with the
//! grok_build todo infrastructure.

use std::fmt::Write;

use crate::implementations::grok_build::todo::{TodoItem, TodoPriority, TodoState, TodoStatus};
use crate::types::output::{TodoWriteOutput, TodoWriteSuccess};
use crate::types::requirements::{Expr, ToolRequirement};
#[allow(unused_imports)]
use crate::types::resources::{SharedResources, State};
use crate::types::tool::{ToolKind, ToolNamespace};

// ─── Description ─────────────────────────────────────────────────────

const DESCRIPTION: &str = r#"Replace the session todo list with the complete list you send.

Use this when the request has more than one step. Prefer at most four items taken from that request. Call again only when the plan changes — not after every step.

Each item needs content, status (pending | in_progress | completed | cancelled), and priority (high | medium | low, default medium). Keep at most one item in_progress."#;

// ─── Input ───────────────────────────────────────────────────────────

/// A single todo item in the opencode format.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct OpenCodeTodoItem {
    /// Brief description of the task.
    #[schemars(description = "Brief description of the task")]
    pub content: String,

    /// Current status: "pending", "in_progress", "completed", or "cancelled".
    #[schemars(
        description = "The current status of the todo item: pending, in_progress, completed, or cancelled"
    )]
    pub status: String,

    /// Priority level: "high", "medium", or "low". Defaults to "medium" when omitted.
    #[serde(default)]
    #[schemars(description = "Priority level: high, medium, or low (default medium)")]
    pub priority: String,
}

/// Input for the opencode `todowrite` tool.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct TodoWriteInput {
    /// The complete todo list. Replaces all existing todos.
    #[schemars(
        description = "Array of todo items — the complete updated todo list. Replaces all existing todos."
    )]
    pub todos: Vec<OpenCodeTodoItem>,
}

// ─── ToolInput conversions (via Dynamic variant) ─────────────────────

impl TryFrom<crate::types::tool_io::ToolInput> for TodoWriteInput {
    type Error = String;
    fn try_from(value: crate::types::tool_io::ToolInput) -> Result<Self, Self::Error> {
        match value {
            crate::types::tool_io::ToolInput::Dynamic(v) => {
                serde_json::from_value(v).map_err(|e| format!("TodoWriteInput: {e}"))
            }
            _ => Err("expected Dynamic variant for TodoWriteInput".into()),
        }
    }
}

impl From<TodoWriteInput> for crate::types::tool_io::ToolInput {
    fn from(value: TodoWriteInput) -> Self {
        crate::types::tool_io::ToolInput::Dynamic(
            serde_json::to_value(value).expect("TodoWriteInput serializes to JSON"),
        )
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/// Parse a status string into `TodoStatus`, defaulting to `Pending`.
fn parse_status(s: &str) -> TodoStatus {
    match s {
        "in_progress" => TodoStatus::InProgress,
        "completed" => TodoStatus::Completed,
        "cancelled" => TodoStatus::Cancelled,
        // "pending" and anything unrecognized
        _ => TodoStatus::Pending,
    }
}

/// Parse a priority string into `TodoPriority`, defaulting to `Medium`.
fn parse_priority(s: &str) -> TodoPriority {
    match s {
        "high" => TodoPriority::High,
        "low" => TodoPriority::Low,
        // "medium" and anything unrecognized
        _ => TodoPriority::Medium,
    }
}

/// Build a human-readable summary of the current todo state.
fn summarize(todos: &[TodoItem]) -> String {
    if todos.is_empty() {
        return "No tasks currently tracked.".into();
    }
    let mut out = String::new();
    for (i, t) in todos.iter().enumerate() {
        writeln!(&mut out, "- {} {}: {}", t.status.tag(), i + 1, t.content).ok();
    }
    out
}

// ─── Tool ────────────────────────────────────────────────────────────

/// OpenCode `todowrite` tool.
#[derive(Debug, Default)]
pub struct TodoWriteTool;

// ─── Tests ───────────────────────────────────────────────────────────

impl crate::types::tool_metadata::ToolMetadata for TodoWriteTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Plan
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::OpenCode
    }

    fn description_template(&self) -> &str {
        DESCRIPTION
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        Expr::True
    }
}

impl xai_tool_runtime::Tool for TodoWriteTool {
    type Args = TodoWriteInput;
    type Output = TodoWriteOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("todowrite").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "todowrite",
            crate::types::tool_metadata::ToolMetadata::sanitized_description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: false,
            tool_scope: Some(xai_tool_protocol::ToolScope::Read),
            ..Default::default()
        }
    }

    #[tracing::instrument(
        name = "tool.opencode.todowrite",
        skip_all,
        fields(todo_count = input.todos.len())
    )]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: TodoWriteInput,
    ) -> Result<TodoWriteOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;

        let (summary_for_prompt, todos, state_snapshot) = {
            let mut res = resources.lock().await;
            let todo_state = res.get_or_default::<State<TodoState>>();

            // Full-replace: clear existing state and insert all incoming items.
            todo_state.0.clear();

            for (i, item) in input.todos.iter().enumerate() {
                let status = parse_status(&item.status);
                let priority = parse_priority(&item.priority);

                // Use a positional id since opencode items don't carry IDs.
                let id = format!("{}", i + 1);

                todo_state.0.push(
                    id,
                    TodoItem {
                        content: item.content.clone(),
                        priority,
                        status,
                        meta: None,
                    },
                );
            }

            let todos: Vec<TodoItem> = todo_state.0.todo_items().cloned().collect();
            let state_snapshot = todo_state.0.clone();
            let summary_for_prompt = summarize(&todos);

            (summary_for_prompt, todos, state_snapshot)
        };

        Ok(TodoWriteOutput::TodosUpdated(TodoWriteSuccess {
            summary_for_prompt,
            todos,
            state: state_snapshot,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::tool_metadata::test_ctx;

    #[allow(unused_imports)]
    use crate::types::resources::Resources;

    fn make_item(content: &str, status: &str, priority: &str) -> OpenCodeTodoItem {
        OpenCodeTodoItem {
            content: content.to_owned(),
            status: status.to_owned(),
            priority: priority.to_owned(),
        }
    }

    /// Unwrap a `TodoWriteOutput` expecting the `TodosUpdated` variant.
    fn expect_success(output: TodoWriteOutput) -> TodoWriteSuccess {
        match output {
            TodoWriteOutput::TodosUpdated(s) => s,
            other => panic!("expected TodosUpdated, got {other:?}"),
        }
    }

    #[test]
    fn description_is_the_short_plan_change_contract() {
        use crate::types::tool_metadata::ToolMetadata;
        let desc = TodoWriteTool.description_template();
        assert!(
            desc.contains("Prefer at most four items taken from that request"),
            "must prefer four items: {desc}"
        );
        assert!(
            desc.contains("Call again only when the plan changes"),
            "must call again only when the plan changes: {desc}"
        );
        assert!(
            !desc.contains("When in doubt, use this tool"),
            "must not tell the model to use the tool when in doubt: {desc}"
        );
        assert!(
            !desc.contains("Update task status in real-time"),
            "must not ask for real-time status updates: {desc}"
        );
    }

    #[test]
    fn id_and_kind() {
        use crate::types::tool_metadata::ToolMetadata;
        let tool = TodoWriteTool;
        assert_eq!(xai_tool_runtime::Tool::id(&tool).as_str(), "todowrite");
        assert!(matches!(tool.kind(), ToolKind::Plan));
    }

    #[tokio::test]
    async fn basic_replace() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let input = TodoWriteInput {
            todos: vec![
                make_item("Build project", "in_progress", "high"),
                make_item("Run tests", "pending", "medium"),
            ],
        };

        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );
        assert_eq!(output.todos.len(), 2);
        assert!(output.summary_for_prompt.contains("Build project"));
        assert!(output.summary_for_prompt.contains("Run tests"));
    }

    #[tokio::test]
    async fn replace_clears_previous() {
        let tool = TodoWriteTool;
        let resources = Resources::new();
        let shared = resources.into_shared();

        // First call
        let input1 = TodoWriteInput {
            todos: vec![make_item("Old task", "completed", "low")],
        };
        xai_tool_runtime::Tool::run(&tool, test_ctx(shared.clone()), input1)
            .await
            .unwrap();

        // Second call replaces everything
        let input2 = TodoWriteInput {
            todos: vec![make_item("New task", "pending", "high")],
        };
        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(shared.clone()), input2)
                .await
                .unwrap(),
        );

        assert_eq!(output.todos.len(), 1);
        assert!(output.summary_for_prompt.contains("New task"));
        assert!(!output.summary_for_prompt.contains("Old task"));
    }

    #[tokio::test]
    async fn empty_todos() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let input = TodoWriteInput { todos: vec![] };
        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );

        assert!(output.todos.is_empty());
        assert!(output.summary_for_prompt.contains("No tasks"));
    }

    #[tokio::test]
    async fn state_persists_in_resources() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let input = TodoWriteInput {
            todos: vec![make_item("Task A", "pending", "medium")],
        };
        let shared = resources.into_shared();
        xai_tool_runtime::Tool::run(&tool, test_ctx(shared.clone()), input)
            .await
            .unwrap();

        let res = shared.lock().await;
        let state = res.get::<State<TodoState>>().unwrap();
        assert_eq!(state.0.todo_items().count(), 1);
    }

    #[test]
    fn parse_status_variants() {
        assert_eq!(parse_status("pending"), TodoStatus::Pending);
        assert_eq!(parse_status("in_progress"), TodoStatus::InProgress);
        assert_eq!(parse_status("completed"), TodoStatus::Completed);
        assert_eq!(parse_status("cancelled"), TodoStatus::Cancelled);
        // Unknown defaults to Pending
        assert_eq!(parse_status("unknown"), TodoStatus::Pending);
    }

    #[test]
    fn parse_priority_variants() {
        assert_eq!(parse_priority("high"), TodoPriority::High);
        assert_eq!(parse_priority("medium"), TodoPriority::Medium);
        assert_eq!(parse_priority("low"), TodoPriority::Low);
        // Unknown defaults to Medium
        assert_eq!(parse_priority("unknown"), TodoPriority::Medium);
    }

    #[tokio::test]
    async fn cancelled_status_parsed() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let input = TodoWriteInput {
            todos: vec![make_item("Dropped task", "cancelled", "low")],
        };
        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );

        assert_eq!(
            output.todos.first().map(|t| t.status),
            Some(TodoStatus::Cancelled)
        );
    }

    #[tokio::test]
    async fn summary_format() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let input = TodoWriteInput {
            todos: vec![
                make_item("First", "completed", "high"),
                make_item("Second", "in_progress", "medium"),
                make_item("Third", "pending", "low"),
            ],
        };
        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );

        assert!(output.summary_for_prompt.contains("[completed] 1: First"));
        assert!(
            output
                .summary_for_prompt
                .contains("[in_progress] 2: Second")
        );
        assert!(output.summary_for_prompt.contains("[pending] 3: Third"));
    }

    #[test]
    fn namespace_verification() {
        use crate::types::tool_metadata::ToolMetadata;
        let tool = TodoWriteTool;
        assert!(matches!(tool.tool_namespace(), ToolNamespace::OpenCode));
    }

    #[test]
    fn serde_roundtrip() {
        let input = TodoWriteInput {
            todos: vec![
                make_item("Task A", "pending", "high"),
                make_item("Task B", "in_progress", "medium"),
                make_item("Task C", "completed", "low"),
            ],
        };
        let json = serde_json::to_value(&input).unwrap();

        // Verify the JSON structure has the expected shape.
        let Some(arr) = json.get("todos").and_then(|v| v.as_array()) else {
            panic!("todos array: {json}");
        };
        assert_eq!(arr.len(), 3);
        assert_eq!(
            arr.first().and_then(|v| v.get("content")),
            Some(&serde_json::json!("Task A"))
        );
        assert_eq!(
            arr.first().and_then(|v| v.get("status")),
            Some(&serde_json::json!("pending"))
        );
        assert_eq!(
            arr.first().and_then(|v| v.get("priority")),
            Some(&serde_json::json!("high"))
        );

        // Round-trip back.
        let deserialized: TodoWriteInput = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.todos.len(), 3);
        let [_, b, c] = deserialized.todos.as_slice() else {
            panic!("expected 3 todos: {:?}", deserialized.todos);
        };
        assert_eq!(b.content, "Task B");
        assert_eq!(b.status, "in_progress");
        assert_eq!(c.priority, "low");
    }

    #[tokio::test]
    async fn large_todo_list() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let todos: Vec<OpenCodeTodoItem> = (0..25)
            .map(|i| make_item(&format!("Task {i}"), "pending", "medium"))
            .collect();
        let input = TodoWriteInput { todos };

        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );
        assert_eq!(output.todos.len(), 25);
        for i in 0..25 {
            assert!(
                output.summary_for_prompt.contains(&format!("Task {i}")),
                "missing Task {i} in summary"
            );
        }
    }

    #[tokio::test]
    async fn priority_preserved() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let input = TodoWriteInput {
            todos: vec![
                make_item("High task", "pending", "high"),
                make_item("Medium task", "pending", "medium"),
                make_item("Low task", "pending", "low"),
            ],
        };
        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );

        let [high, medium, low, ..] = output.todos.as_slice() else {
            panic!("expected 3 todos: {:?}", output.todos);
        };
        assert_eq!(high.priority, TodoPriority::High);
        assert_eq!(medium.priority, TodoPriority::Medium);
        assert_eq!(low.priority, TodoPriority::Low);
    }

    /// A real-model call omitted `priority`; the item must still store and run as medium.
    #[tokio::test]
    async fn omitted_priority_defaults_to_medium() {
        let tool = TodoWriteTool;
        let resources = Resources::new();
        let input: TodoWriteInput = serde_json::from_value(serde_json::json!({
            "todos": [{"content": "Locate the failure", "status": "in_progress"}]
        }))
        .expect("an item without priority must deserialize");
        assert_eq!(input.todos[0].priority, "");

        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );
        assert_eq!(output.todos.len(), 1);
        assert_eq!(output.todos[0].priority, TodoPriority::Medium);
    }

    #[tokio::test]
    async fn mixed_statuses() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let input = TodoWriteInput {
            todos: vec![
                make_item("Pending task", "pending", "medium"),
                make_item("Active task", "in_progress", "high"),
                make_item("Done task", "completed", "low"),
                make_item("Dropped task", "cancelled", "medium"),
            ],
        };
        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );

        assert_eq!(output.todos.len(), 4);
        let [pending, active, done, dropped] = output.todos.as_slice() else {
            panic!("expected 4 todos: {:?}", output.todos);
        };
        assert_eq!(pending.status, TodoStatus::Pending);
        assert_eq!(active.status, TodoStatus::InProgress);
        assert_eq!(done.status, TodoStatus::Completed);
        assert_eq!(dropped.status, TodoStatus::Cancelled);
    }

    #[tokio::test]
    async fn repeated_calls() {
        let tool = TodoWriteTool;
        let resources = Resources::new();
        let shared = resources.into_shared();

        // Call 1
        let input1 = TodoWriteInput {
            todos: vec![make_item("First batch", "pending", "high")],
        };
        xai_tool_runtime::Tool::run(&tool, test_ctx(shared.clone()), input1)
            .await
            .unwrap();

        // Call 2
        let input2 = TodoWriteInput {
            todos: vec![
                make_item("Second A", "in_progress", "medium"),
                make_item("Second B", "pending", "low"),
            ],
        };
        xai_tool_runtime::Tool::run(&tool, test_ctx(shared.clone()), input2)
            .await
            .unwrap();

        // Call 3 — only these should survive.
        let input3 = TodoWriteInput {
            todos: vec![
                make_item("Final X", "completed", "high"),
                make_item("Final Y", "pending", "medium"),
                make_item("Final Z", "in_progress", "low"),
            ],
        };
        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(shared.clone()), input3)
                .await
                .unwrap(),
        );

        assert_eq!(output.todos.len(), 3);
        assert!(!output.summary_for_prompt.contains("First batch"));
        assert!(!output.summary_for_prompt.contains("Second A"));
        assert!(!output.summary_for_prompt.contains("Second B"));
        assert!(output.summary_for_prompt.contains("Final X"));
        assert!(output.summary_for_prompt.contains("Final Y"));
        assert!(output.summary_for_prompt.contains("Final Z"));

        // Verify shared state also only has 3 items.
        let res = shared.lock().await;
        let state = res.get::<State<TodoState>>().unwrap();
        assert_eq!(state.0.todo_items().count(), 3);
    }

    #[test]
    fn serde_opencode_todo_item() {
        let item = OpenCodeTodoItem {
            content: "Write tests".to_owned(),
            status: "in_progress".to_owned(),
            priority: "high".to_owned(),
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json.get("content"), Some(&serde_json::json!("Write tests")));
        assert_eq!(json.get("status"), Some(&serde_json::json!("in_progress")));
        assert_eq!(json.get("priority"), Some(&serde_json::json!("high")));

        // Deserialize back.
        let recovered: OpenCodeTodoItem = serde_json::from_value(json).unwrap();
        assert_eq!(recovered.content, "Write tests");
        assert_eq!(recovered.status, "in_progress");
        assert_eq!(recovered.priority, "high");
    }

    #[tokio::test]
    async fn status_preserved_per_item() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let input = TodoWriteInput {
            todos: vec![
                make_item("Pending task", "pending", "medium"),
                make_item("Active task", "in_progress", "medium"),
                make_item("Done task", "completed", "medium"),
                make_item("Dropped task", "cancelled", "medium"),
            ],
        };
        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );

        let [pending, active, done, dropped, ..] = output.todos.as_slice() else {
            panic!("expected 4 todos: {:?}", output.todos);
        };
        assert_eq!(pending.status, TodoStatus::Pending);
        assert_eq!(active.status, TodoStatus::InProgress);
        assert_eq!(done.status, TodoStatus::Completed);
        assert_eq!(dropped.status, TodoStatus::Cancelled);
    }

    #[tokio::test]
    async fn state_snapshot_in_output() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let input = TodoWriteInput {
            todos: vec![
                make_item("Task A", "pending", "high"),
                make_item("Task B", "in_progress", "medium"),
                make_item("Task C", "completed", "low"),
            ],
        };
        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );

        // output.state should be a valid TodoState with all 3 items.
        assert!(!output.state.is_empty());
        assert_eq!(output.state.todo_items().count(), 3);

        // Verify items in the snapshot match the input.
        let items: Vec<_> = output.state.todo_items().collect();
        let [a, b, c] = items.as_slice() else {
            panic!("expected 3 items: {items:?}");
        };
        assert_eq!(a.content, "Task A");
        assert_eq!(b.content, "Task B");
        assert_eq!(c.content, "Task C");
    }

    #[tokio::test]
    async fn runtime_trait_interface() {
        let tool = TodoWriteTool;
        let resources = Resources::new();

        let input = TodoWriteInput {
            todos: vec![
                make_item("Build project", "in_progress", "high"),
                make_item("Run tests", "pending", "medium"),
            ],
        };
        let output = expect_success(
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
                .await
                .unwrap(),
        );
        assert_eq!(output.todos.len(), 2);
        assert!(output.summary_for_prompt.contains("Build project"));
        assert!(output.summary_for_prompt.contains("Run tests"));
    }
}
