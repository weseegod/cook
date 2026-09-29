use super::{
    allowed_on_surface, entry_reminder, is_save_working_plan, save_working_plan,
    working_plan_skill_body,
};

const SAMPLE: &str = "\
# Plan: Build the board game

## Goal
A playable board in the browser.

## Steps
- [ ] `index.html` — add the page. Done when: the file exists and loads the script.
- [ ] `js/app.js` — add the loop. Done when: the check script runs.
";

#[test]
fn working_plan_skill_keeps_the_checklist_in_the_file() {
    assert!(working_plan_skill_body.contains("save_working_plan"));
    let tests_at = working_plan_skill_body
        .find("## Acceptance criteria")
        .expect("passive plans name the criteria");
    assert!(working_plan_skill_body.contains("pass or fail"));
    assert!(working_plan_skill_body.contains("do not name a script you have not written"));
    assert!(!working_plan_skill_body.contains("## Tests\n"));
    let steps_at = working_plan_skill_body
        .find("## Steps")
        .expect("the checklist is the last section");
    assert!(tests_at < steps_at);
    assert!(working_plan_skill_body.contains("Product:"));
    assert!(working_plan_skill_body.contains("Test or harness:"));
    assert!(working_plan_skill_body.contains("Environment:"));
    assert!(working_plan_skill_body.contains("`- [ ]` to `- [x]`"));
    assert!(
        !working_plan_skill_body.contains("## Files\n"),
        "passive plans do not include a Files section to fill in"
    );
    assert!(
        !working_plan_skill_body.contains("todo list"),
        "the checklist stays in the plan file"
    );
}

#[test]
fn working_plan_save_keeps_steps_and_overwrites_the_same_episode() {
    let dir = tempfile::tempdir().unwrap();
    let tracker = crate::session::plan_mode::PlanModeTracker::new(dir.path().to_path_buf());
    let path = save_working_plan(dir.path(), SAMPLE, None).unwrap();
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with("build-the-board-game-"),
        "published name {name}"
    );
    let saved = std::fs::read_to_string(&path).unwrap();
    assert!(saved.contains("## Steps"), "{saved}");
    assert!(saved.contains("- [ ] `index.html`"));
    let updated = SAMPLE.replace("- [ ] `index.html`", "- [x] `index.html`");
    let again = save_working_plan(dir.path(), &updated, Some(&path)).unwrap();
    assert_eq!(again, path);
    let saved = std::fs::read_to_string(&path).unwrap();
    assert!(saved.contains("- [x] `index.html`"));
    assert!(saved.contains("- [ ] `js/app.js`"));
    let episodes = std::fs::read_dir(dir.path().join("plans"))
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
        .count();
    assert_eq!(episodes, 1);
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
