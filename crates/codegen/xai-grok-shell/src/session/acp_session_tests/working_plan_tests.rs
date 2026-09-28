use super::{
    allowed_on_surface, entry_reminder, is_save_working_plan, save_working_plan,
    working_plan_shape as validate_working_plan_shape, working_plan_skill_body,
};

const SAMPLE: &str = "\
# Plan: Build the board game

## Goal
A playable board in the browser.

## Files
- `index.html` — page shell
- `js/app.js` — game loop

## Steps
- [ ] `index.html` — add the page. Done when: the file exists and loads the script.
- [ ] `js/app.js` — add the loop. Done when: the check script runs.
";

#[test]
fn working_plan_shape() {
    assert!(
        validate_working_plan_shape(SAMPLE).is_ok(),
        "short plan should pass"
    );
    let missing_steps = SAMPLE.replace("## Steps\n", "## Notes\n");
    let error = validate_working_plan_shape(&missing_steps).unwrap_err();
    assert!(error.contains("Steps"), "{error}");
    let review = crate::session::plan_contract::validate_plan_contract(SAMPLE);
    assert!(review.is_err(), "review contract stays strict");
    assert!(working_plan_skill_body.contains("save_working_plan"));
}

#[test]
fn working_plan_save() {
    let dir = tempfile::tempdir().unwrap();
    let tracker = crate::session::plan_mode::PlanModeTracker::new(dir.path().to_path_buf());
    let path = save_working_plan(dir.path(), SAMPLE).unwrap();
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with("build-the-board-game-"),
        "published name {name}"
    );
    assert!(path.is_file());
    assert!(!tracker.is_active());
    assert!(tracker.plan_file_path().ends_with("plan.md"));
    assert!(allowed_on_surface(
        true,
        xai_grok_agent::ToolSurface::TaskOpen
    ));
    assert!(!allowed_on_surface(true, xai_grok_agent::ToolSurface::Plan));
    assert!(!allowed_on_surface(
        true,
        xai_grok_agent::ToolSurface::Implement
    ));
    assert!(!allowed_on_surface(
        false,
        xai_grok_agent::ToolSurface::TaskOpen
    ));
    assert!(is_save_working_plan("save_working_plan"));
    assert!(is_save_working_plan("GrokBuild:save_working_plan"));
    assert!(!is_save_working_plan("MCP:save_working_plan"));
}

#[test]
fn working_plan_reminder() {
    let open = entry_reminder(xai_grok_agent::ToolSurface::TaskOpen);
    let implement = entry_reminder(xai_grok_agent::ToolSurface::Implement);
    assert!(open.contains("working-plan"));
    assert!(open.contains("Skip this for a small edit."));
    assert!(open.contains("Do not end the turn on a promise"));
    assert!(!implement.contains("working-plan"));
    assert!(implement.contains("Do not end the turn on a promise"));
}
