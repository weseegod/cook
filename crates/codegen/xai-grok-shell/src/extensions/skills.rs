use agent_client_protocol as acp;
use serde::{Deserialize, Serialize};

use crate::extensions::agent_runtime::AgentRuntime;
use crate::session::skill_defaults;
use crate::util::config as cli_config;
use xai_grok_agent::prompt::skills::{
    CompatConfig, SkillInfo, SkillsConfig, collect_config_skills, list_skills_with_plugins,
};
use xai_grok_telemetry::events::{HarnessChangeOp, HarnessChanged, HarnessSurfaceKind};

use super::ExtResult;

/// Generic params for methods that only need an optional `cwd`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CwdParams {
    #[serde(default)]
    cwd: Option<String>,
}

/// The `cwd` a skills request is scoped to, if it names one (every request shape carries the field
/// under the same name; unknown fields are ignored).
pub(crate) fn request_cwd(args: &acp::ExtRequest) -> Option<std::path::PathBuf> {
    serde_json::from_str::<CwdParams>(args.params.get())
        .ok()
        .and_then(|p| p.cwd)
        .map(std::path::PathBuf::from)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsAddRequest {
    /// Path to add (directory or SKILL.md file). Supports `~` expansion.
    pub path: String,
    /// Working directory for skill discovery context.
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsAddResponse {
    /// Number of skills discovered at the added path.
    pub added_count: usize,
    /// Total number of skills loaded across all sources.
    pub total: usize,
    /// The path that was added to config.
    pub path: String,
    /// Full updated skill list after reload.
    pub skills: Vec<SkillInfo>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsRemoveRequest {
    /// Path to remove from config paths.
    pub path: String,
    /// Working directory for skill discovery context.
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsRemoveResponse {
    pub path: String,
    /// Full updated skill list after reload.
    pub skills: Vec<SkillInfo>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsResetResponse {
    /// Full updated skill list after reload.
    pub skills: Vec<SkillInfo>,
    pub message: String,
}

/// Request for `x.ai/skills/default` and `x.ai/skills/restore`. Only a name in the compiled
/// shipped-skill table resolves; every other name has no default to read or return to.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDefaultRequest {
    pub name: String,
    /// Working directory for skill discovery context.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Answer for `x.ai/skills/default`: the shipped body and the user's copy of one skill.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDefaultView {
    pub name: String,
    /// `<cook home>/skills/<name>/SKILL.md`, empty when the skill ships no default.
    pub path: String,
    /// Whether Cook ships this skill, so Settings can offer Reset at all.
    pub has_default: bool,
    /// `absent` | `unmodified` | `modified`.
    pub state: &'static str,
    /// The user's copy; `None` when there is none.
    pub content: Option<String>,
    /// The compiled shipped body, empty when the skill ships no default.
    pub default: String,
}

/// Answer for `x.ai/skills/restore`, which writes the shipped body over the user's copy.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRestoreResult {
    pub name: String,
    /// `unmodified` once the shipped body is back in place.
    pub state: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillsToggleRequest {
    pub name: String,
    pub enabled: bool,
    /// Working directory for skill discovery context.
    #[serde(default)]
    pub cwd: Option<String>,
}

pub const SKILLS_LIST_METHOD: &str = "x.ai/skills/list";
pub const SKILLS_TOGGLE_METHOD: &str = "x.ai/skills/toggle";

/// Wire DTO for the `x.ai/skills/list` ext request. `pub` with both serde directions so ACP
/// clients (xai-grok-pager) build the request from the same type the agent parses.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListRequest {
    /// Working directory for skill discovery context.
    pub cwd: String,
    /// The session whose skills to list; the shell lists by `cwd`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<acp::SessionId>,
    /// Rescan the skill folders instead of answering from a cache; the shell always rescans.
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowsListRequest {
    session_id: acp::SessionId,
}

/// Wire DTO for the `x.ai/skills/list` and `x.ai/skills/toggle` answers, in both serde directions
/// for the same reason as [`SkillsListRequest`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListResponse {
    pub skills: Vec<SkillInfo>,
    /// Folders a backend could not scan; the shell reports none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scan_errors: Vec<SkillScanError>,
}

impl From<Vec<SkillInfo>> for SkillsListResponse {
    fn from(skills: Vec<SkillInfo>) -> Self {
        Self {
            skills,
            scan_errors: Vec::new(),
        }
    }
}

/// A folder a backend could not scan for skills.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillScanError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsConfigResponse {
    /// Configured paths from `[skills].paths`.
    pub paths: Vec<String>,
    /// Ignored paths from `[skills].ignore`.
    pub ignore: Vec<String>,
    pub total_skills: usize,
    pub message: String,
    pub skills: Vec<SkillInfo>,
}

/// Reload skills using the current config for the given working directory.
#[tracing::instrument(skip_all, fields(cwd))]
async fn reload_skills(
    cwd: &str,
    plugin_registry: Option<&xai_grok_agent::plugins::PluginRegistry>,
    compat: CompatConfig,
) -> Vec<SkillInfo> {
    let config = cli_config::load_config().await.skills;
    let project_trusted =
        crate::agent::folder_trust::project_scope_allowed(std::path::Path::new(cwd));
    let discovery =
        list_skills_with_plugins(Some(cwd), &config, plugin_registry, compat, project_trusted);
    match tokio::time::timeout(std::time::Duration::from_secs(5), discovery).await {
        Ok(skills) => {
            if let Err(error) = cli_config::sync_skills_status(&skills).await {
                tracing::warn!(%error, "Failed to synchronize skill status");
            }
            skills
        }
        Err(_) => {
            tracing::warn!("Skills reload timed out");
            vec![]
        }
    }
}

/// Count how many skills have paths starting with the given prefix.
fn count_skills_from(skills: &[SkillInfo], dir: &std::path::Path) -> usize {
    let prefix = dir.to_str().unwrap_or("");
    skills.iter().filter(|s| s.path.starts_with(prefix)).count()
}

/// The skills one `[skills].paths` entry contributes, classified exactly as the loader will classify them
/// (`Repo` inside the cwd's git root, else `User`), so `harness_changed` and `skill_dispatched` agree on `skill_source`.
/// Scanned directly rather than diffed from a reload, so the names are known before the config write and still
/// known once a removed path leaves the list.
async fn skills_at_config_path(resolved: &str, cwd: &str) -> Vec<SkillInfo> {
    let paths = vec![resolved.to_owned()];
    let cwd = std::path::PathBuf::from(cwd);
    // Same bound as `reload_skills`: a slow or huge tree must not stall the runtime; the per-item
    // telemetry is best-effort and the count-only events still fire when this gives up.
    let scan = tokio::task::spawn_blocking(move || {
        let git_root = xai_grok_agent::repo::RepoDirChain::resolve(&cwd).git_root;
        collect_config_skills(&paths, git_root.as_deref())
    });
    match tokio::time::timeout(std::time::Duration::from_secs(5), scan).await {
        Ok(Ok(skills)) => skills,
        Ok(Err(join_error)) => {
            tracing::warn!(%join_error, "skill path scan panicked");
            vec![]
        }
        Err(_) => {
            tracing::warn!("skill path scan timed out");
            vec![]
        }
    }
}

/// Bounds the per-item fan-out of one add/remove; a path holding more skills than this reports only the first ones.
const HARNESS_CHANGED_MAX_ITEMS: usize = 100;

fn log_harness_changed(skills: &[SkillInfo], op: HarnessChangeOp, success: bool) {
    for skill in skills.iter().take(HARNESS_CHANGED_MAX_ITEMS) {
        xai_grok_telemetry::session_ctx::log_event(HarnessChanged {
            kind: HarnessSurfaceKind::Skill,
            op,
            name: skill.name.clone(),
            skill_source: crate::session::telemetry::skill_source(
                skill.scope,
                skill.plugin_name.as_deref(),
            )
            .to_owned(),
            origin: skill.origin.clone(),
            // None here: a `[skills].paths` entry is never a plugin skill
            plugin_source: skill.plugin_name.clone(),
            success,
        });
    }
}

/// Handles `~` expansion and relative path resolution against `cwd`.
/// Falls back to the original string if canonicalization fails.
fn resolve_skill_path(raw: &str, cwd: &str) -> String {
    use std::path::PathBuf;

    // Expand ~ to the home directory
    let expanded = if let Some(rest) = raw.strip_prefix("~/") {
        xai_dirs::home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(raw))
    } else if raw == "~" {
        xai_dirs::home_dir().unwrap_or_else(|| PathBuf::from(raw))
    } else {
        PathBuf::from(raw)
    };

    // If already absolute, canonicalize to resolve `..` etc.
    // If relative, join with cwd first.
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        PathBuf::from(cwd).join(&expanded)
    };

    // canonicalize resolves symlinks and `..`; fall back to the joined path if it fails (e.g. the path doesn't exist yet)
    dunce::canonicalize(&absolute)
        .unwrap_or(absolute)
        .to_string_lossy()
        .to_string()
}

/// Collect auto-discovered skill source directories and their counts.
fn discover_auto_sources(cwd: &str, skills: &[SkillInfo]) -> Vec<(String, usize)> {
    let cwd_path = std::path::PathBuf::from(cwd);
    let grok_home = xai_grok_tools::util::grok_home::grok_home();
    let git_root = git2::Repository::discover(&cwd_path)
        .ok()
        .and_then(|repo| repo.workdir().map(|p| p.to_path_buf()));

    // After /import-claude, do not list hardcoded .claude/skills/ paths.
    // Import writes those dirs to [paths] extra_skill_dirs for the source UI.
    // list_skills_with_plugins still does not read extra_skill_dirs.
    let imported = crate::claude_import::is_claude_import_marked();
    let local_dir_names: &[&str] = if imported {
        &[".grok", ".agents"]
    } else {
        &[".grok", ".agents", ".claude"]
    };

    let mut sources: Vec<(String, usize)> = Vec::new();
    let subdirs = ["skills", "commands"];

    let mut try_add_source = |dir: std::path::PathBuf, seen: Option<&[std::path::PathBuf]>| {
        if dir.is_dir() && !seen.is_some_and(|s| s.contains(&dir)) {
            let count = count_skills_from(skills, &dir);
            if count > 0 {
                sources.push((dir.to_string_lossy().to_string(), count));
            }
        }
    };

    let mut local_dirs: Vec<std::path::PathBuf> = Vec::new();
    for dir_name in local_dir_names {
        for subdir in &subdirs {
            let dir = cwd_path.join(dir_name).join(subdir);
            try_add_source(dir.clone(), None);
            local_dirs.push(dir);
        }
    }

    if let Some(ref root) = git_root {
        for dir_name in local_dir_names {
            for subdir in &subdirs {
                try_add_source(root.join(dir_name).join(subdir), Some(&local_dirs));
            }
        }
    }

    for subdir in &subdirs {
        try_add_source(grok_home.join(subdir), None);
    }

    if let Some(home_path) = xai_dirs::home_dir() {
        for subdir in &subdirs {
            try_add_source(home_path.join(".agents").join(subdir), None);
        }
        if !imported {
            for subdir in &subdirs {
                try_add_source(home_path.join(".claude").join(subdir), None);
            }
        }
    }

    // [paths] extra_skill_dirs appear as source folders after /import-claude.
    // Discovery does not load them. Extra injection dirs belong in [skills] paths.
    for dir in extra_skill_dirs_from_config() {
        let path = crate::util::expand_home(&dir);
        if path.is_dir()
            && !sources
                .iter()
                .any(|(s, _)| s.as_str() == path.to_string_lossy().as_ref())
        {
            sources.push((
                path.to_string_lossy().to_string(),
                count_skills_from(skills, &path),
            ));
        }
    }

    sources
}

/// Read `[paths] extra_skill_dirs` from the effective config.
/// Returns empty on any read/parse failure so misconfiguration never breaks listing.
fn extra_skill_dirs_from_config() -> Vec<String> {
    let Ok(root) = crate::config::load_effective_config() else {
        return Vec::new();
    };
    root.get("paths")
        .and_then(|v| v.get("extra_skill_dirs"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

#[tracing::instrument(skip_all, fields(method = %args.method))]
pub async fn handle(
    agent: &dyn AgentRuntime,
    args: &acp::ExtRequest,
    plugin_registry: Option<&xai_grok_agent::plugins::PluginRegistry>,
    compat: CompatConfig,
) -> ExtResult {
    match args.method.as_ref() {
        "x.ai/skills/add" => {
            let req: SkillsAddRequest = serde_json::from_str(args.params.get())?;
            let cwd = req.cwd.as_deref().unwrap_or(".");

            // Resolve to absolute path so config entries work from any cwd.
            let resolved = resolve_skill_path(&req.path, cwd);
            let changed = skills_at_config_path(&resolved, cwd).await;

            let p = resolved.clone();
            if let Err(e) = cli_config::update_config(|cfg| {
                cfg.skills.ignore.retain(|i| {
                    !(i == &p || p.starts_with(i.as_str()) || i.starts_with(p.as_str()))
                });
                if !cfg.skills.paths.contains(&p) {
                    cfg.skills.paths.push(p);
                }
            })
            .await
            {
                xai_grok_telemetry::session_ctx::log_event(
                    xai_grok_telemetry::events::SkillAdded {
                        added_count: 0,
                        total_skills: 0,
                        success: false,
                    },
                );
                log_harness_changed(&changed, HarnessChangeOp::Added, false);
                return super::to_ext_response(Err::<SkillsAddResponse, _>(anyhow::anyhow!(
                    "Failed to save config: {e}"
                )));
            }

            let skills = reload_skills(cwd, plugin_registry, compat).await;
            let added_count = skills
                .iter()
                .filter(|s| s.path.starts_with(&resolved))
                .count();
            let total = skills.len();
            let message = format!(
                "Added path {}. {} new skill{} found ({} total).",
                resolved,
                added_count,
                if added_count == 1 { "" } else { "s" },
                total,
            );

            xai_grok_telemetry::session_ctx::log_event(xai_grok_telemetry::events::SkillAdded {
                added_count: added_count as u32,
                total_skills: total as u32,
                success: true,
            });
            log_harness_changed(&changed, HarnessChangeOp::Added, true);
            super::to_ext_response(Ok(SkillsAddResponse {
                added_count,
                total,
                path: resolved,
                skills,
                message,
            }))
        }

        "x.ai/skills/remove" => {
            let req: SkillsRemoveRequest = serde_json::from_str(args.params.get())?;
            let cwd = req.cwd.as_deref().unwrap_or(".");

            // Resolve so relative/tilde paths match what was saved by add.
            let resolved = resolve_skill_path(&req.path, cwd);
            let changed = skills_at_config_path(&resolved, cwd).await;

            let p = resolved.clone();
            if let Err(e) = cli_config::update_config(|cfg| {
                cfg.skills.paths.retain(|i| i != &p);
            })
            .await
            {
                xai_grok_telemetry::session_ctx::log_event(
                    xai_grok_telemetry::events::SkillRemoved { success: false },
                );
                log_harness_changed(&changed, HarnessChangeOp::Removed, false);
                return super::to_ext_response(Err::<SkillsRemoveResponse, _>(anyhow::anyhow!(
                    "Failed to save config: {e}"
                )));
            }

            let skills = reload_skills(cwd, plugin_registry, compat).await;
            let total = skills.len();
            let message = format!(
                "Removed path {}. {} skill{} remaining.",
                resolved,
                total,
                if total == 1 { "" } else { "s" },
            );

            xai_grok_telemetry::session_ctx::log_event(xai_grok_telemetry::events::SkillRemoved {
                success: true,
            });
            log_harness_changed(&changed, HarnessChangeOp::Removed, true);
            super::to_ext_response(Ok(SkillsRemoveResponse {
                path: resolved,
                skills,
                message,
            }))
        }

        "x.ai/skills/reset" => {
            let params: CwdParams =
                serde_json::from_str(args.params.get()).unwrap_or(CwdParams { cwd: None });
            let cwd = params.cwd.as_deref().unwrap_or(".");

            if let Err(e) = cli_config::update_config(|cfg| {
                cfg.skills = SkillsConfig::default();
            })
            .await
            {
                return super::to_ext_response(Err::<SkillsResetResponse, _>(anyhow::anyhow!(
                    "Failed to save config: {e}"
                )));
            }

            let skills = reload_skills(cwd, plugin_registry, compat).await;
            let message = "Custom skills config reset".to_string();

            super::to_ext_response(Ok(SkillsResetResponse { skills, message }))
        }

        SKILLS_LIST_METHOD => {
            let req: SkillsListRequest = serde_json::from_str(args.params.get())?;
            let skills = reload_skills(&req.cwd, plugin_registry, compat).await;
            // Sessions otherwise learn about disk changes only from inotify,
            // which misses writes made through another NFS client.
            agent.refresh_skill_baseline_for_all_sessions();
            super::to_ext_response(Ok(SkillsListResponse::from(skills)))
        }

        "x.ai/workflows/list" => {
            let req: WorkflowsListRequest = serde_json::from_str(args.params.get())?;
            let Some(handle) = agent.session_handle_waiting_for_load(&req.session_id).await else {
                return super::to_ext_response(Err::<serde_json::Value, _>(anyhow::anyhow!(
                    "unknown session id: {}",
                    req.session_id.0
                )));
            };
            let (launches_enabled, _management_available) = handle.workflow_catalog_state().await;
            let workflows = if launches_enabled {
                crate::session::workflow::registry::list_workflows(Some(
                    handle.tool_context.cwd.as_path(),
                ))
            } else {
                Vec::new()
            };
            super::to_ext_response(Ok(serde_json::json!({ "workflows": workflows })))
        }

        "x.ai/skills/config" => {
            let params: CwdParams =
                serde_json::from_str(args.params.get()).unwrap_or(CwdParams { cwd: None });
            let cwd = params.cwd.as_deref().unwrap_or(".");

            let config = cli_config::load_config().await.skills;
            let paths = config.paths.clone();
            let ignore = config.ignore.clone();

            let skills = reload_skills(cwd, plugin_registry, compat).await;
            let total_skills = skills.len();

            let auto_sources = discover_auto_sources(cwd, &skills);

            let mut msg = String::new();

            msg.push_str("Skill discovery sources:\n");
            for (source, count) in &auto_sources {
                msg.push_str(&format!(
                    "  • {}  ({} skill{})\n",
                    source,
                    count,
                    if *count == 1 { "" } else { "s" }
                ));
            }
            if auto_sources.is_empty() {
                msg.push_str("  (no auto-discovered directories found)\n");
            }

            if !paths.is_empty() {
                msg.push_str("\nCustom paths:\n");
                for p in &paths {
                    let count = skills
                        .iter()
                        .filter(|s| s.path.starts_with(p.as_str()))
                        .count();
                    msg.push_str(&format!(
                        "  • {}  ({} skill{})\n",
                        p,
                        count,
                        if count == 1 { "" } else { "s" }
                    ));
                }
            }

            if !ignore.is_empty() {
                msg.push_str("\nIgnored:\n");
                for p in &ignore {
                    msg.push_str(&format!("  • {}\n", p));
                }
            }

            msg.push_str(&format!("\nTotal skills loaded: {}", total_skills));

            super::to_ext_response(Ok(SkillsConfigResponse {
                paths,
                ignore,
                total_skills,
                message: msg,
                skills,
            }))
        }

        SKILLS_TOGGLE_METHOD => {
            let req: SkillsToggleRequest = serde_json::from_str(args.params.get())?;
            let cwd = req.cwd.as_deref().unwrap_or(".");

            // Validate the skill name exists before modifying config.
            let current_skills = reload_skills(cwd, plugin_registry, compat).await;
            if !current_skills.iter().any(|s| s.name == req.name) {
                return super::to_ext_response(Err::<SkillsListResponse, _>(anyhow::anyhow!(
                    "Skill '{}' not found",
                    req.name
                )));
            }

            let name = req.name.clone();
            let enabled = req.enabled;
            if let Err(e) = cli_config::update_config(|cfg| {
                cfg.skills.status.insert(name.clone(), enabled);
                cfg.skills.disabled.retain(|d| d != &name);
            })
            .await
            {
                return super::to_ext_response(Err::<SkillsListResponse, _>(anyhow::anyhow!(
                    "Failed to save config: {e}"
                )));
            }

            // Re-apply disabled marking against the already-loaded skills to reflect the config change without a second full discovery
            let config = cli_config::load_config().await.skills;
            let skills: Vec<SkillInfo> = current_skills
                .into_iter()
                .map(|mut s| {
                    s.enabled = config.is_enabled(&s.name);
                    s
                })
                .collect();
            super::to_ext_response(Ok(SkillsListResponse::from(skills)))
        }

        "x.ai/skills/default" => {
            let req: SkillDefaultRequest = serde_json::from_str(args.params.get())?;
            super::to_ext_response(Ok(skill_default_view(&req.name)))
        }

        "x.ai/skills/restore" => {
            let req: SkillDefaultRequest = serde_json::from_str(args.params.get())?;
            match restore_skill_default(&req.name) {
                Ok(result) => {
                    // Sessions otherwise learn about disk changes only from inotify.
                    agent.refresh_skill_baseline_for_all_sessions();
                    super::to_ext_response(Ok(result))
                }
                Err(error) => super::to_ext_response(Err::<SkillRestoreResult, _>(error)),
            }
        }

        _ => Err(acp::Error::method_not_found()),
    }
}

/// The shipped body and the user's copy for one skill.
///
/// A name the compiled table does not hold is reported as having no default rather than failing, so
/// Settings can ask about any row and simply hide Reset. Reporting instead of erroring also keeps
/// the caller from building a path out of a name nothing vouches for.
fn skill_default_view(name: &str) -> SkillDefaultView {
    skill_default_view_at(&skill_defaults::user_skills_root(), name)
}

/// [`skill_default_view`] against an explicit skills root, so tests are hermetic.
fn skill_default_view_at(skills_root: &std::path::Path, name: &str) -> SkillDefaultView {
    let Some(default) = skill_defaults::default_for(name) else {
        return SkillDefaultView {
            name: name.to_string(),
            path: String::new(),
            has_default: false,
            state: skill_defaults::SkillState::Absent.as_str(),
            content: None,
            default: String::new(),
        };
    };
    let path = skill_defaults::user_copy_path_at(skills_root, name)
        .expect("a name the compiled table holds always resolves a copy path");
    SkillDefaultView {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        has_default: true,
        state: skill_defaults::state_of(&path, default).as_str(),
        content: std::fs::read_to_string(&path).ok(),
        default: default.to_string(),
    }
}

/// Write the shipped body over the user's copy of one skill.
///
/// Refuses a skill Cook does not ship, and refuses a skill with no user copy: writing one would
/// shadow the bundled cache with the build-time text, which is the opposite of putting the shipped
/// default back in use.
fn restore_skill_default(name: &str) -> anyhow::Result<SkillRestoreResult> {
    restore_skill_default_at(&skill_defaults::user_skills_root(), name)
}

/// [`restore_skill_default`] against an explicit skills root, so tests are hermetic.
fn restore_skill_default_at(
    skills_root: &std::path::Path,
    name: &str,
) -> anyhow::Result<SkillRestoreResult> {
    let Some(default) = skill_defaults::default_for(name) else {
        anyhow::bail!(
            "{name} is not a skill Cook ships, so it has no default to restore"
        );
    };
    let path = skill_defaults::user_copy_path_at(skills_root, name)
        .expect("a name the compiled table holds always resolves a copy path");
    if !path.is_file() {
        anyhow::bail!("no user copy at {}, so there is nothing to reset", path.display());
    }
    skill_defaults::restore_at(&path, default)?;
    Ok(SkillRestoreResult {
        name: name.to_string(),
        state: skill_defaults::state_of(&path, default).as_str(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_cwd_reads_the_field_from_any_request_shape() {
        let req = |json: &str| {
            acp::ExtRequest::new(
                "x.ai/skills/list",
                serde_json::value::to_raw_value(
                    &serde_json::from_str::<serde_json::Value>(json).unwrap(),
                )
                .unwrap()
                .into(),
            )
        };
        assert_eq!(
            request_cwd(&req(r#"{"cwd": "/project"}"#)),
            Some(std::path::PathBuf::from("/project"))
        );
        assert_eq!(
            request_cwd(&req(r#"{"path": "/skills", "cwd": "/project"}"#)),
            Some(std::path::PathBuf::from("/project"))
        );
        assert_eq!(request_cwd(&req(r#"{}"#)), None);
    }

    #[test]
    fn test_add_request_with_cwd() {
        let json = r#"{"path": "/home/user/skills", "cwd": "/project"}"#;
        let req: SkillsAddRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.path, "/home/user/skills");
        assert_eq!(req.cwd, Some("/project".to_string()));
    }

    #[test]
    fn test_add_request_without_cwd() {
        let json = r#"{"path": "~/my-skills"}"#;
        let req: SkillsAddRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.path, "~/my-skills");
        assert_eq!(req.cwd, None);
    }

    #[test]
    fn test_remove_request() {
        let json = r#"{"path": "/home/user/skills", "cwd": "/project"}"#;
        let req: SkillsRemoveRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.path, "/home/user/skills");
        assert_eq!(req.cwd, Some("/project".to_string()));
    }

    #[test]
    fn test_list_request() {
        let json = r#"{"cwd": "/project"}"#;
        let req: SkillsListRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.cwd, "/project");
    }

    #[test]
    fn test_add_response_camel_case() {
        let resp = SkillsAddResponse {
            added_count: 3,
            total: 10,
            path: "/test".to_string(),
            skills: vec![],
            message: "ok".to_string(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json.get("addedCount"), Some(&serde_json::json!(3)));
        assert_eq!(json.get("total"), Some(&serde_json::json!(10)));
        assert_eq!(json.get("path"), Some(&serde_json::json!("/test")));
    }

    #[test]
    fn test_resolve_absolute_path_unchanged() {
        let resolved = resolve_skill_path("/absolute/path/to/skills", "/some/cwd");
        // Canonicalize will fail (path doesn't exist), so we get the joined absolute path
        assert_eq!(resolved, "/absolute/path/to/skills");
    }

    #[test]
    fn test_resolve_relative_path_against_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("sub");
        std::fs::create_dir(&sub).unwrap();

        let resolved = resolve_skill_path("sub", &tmp.path().to_string_lossy());
        assert_eq!(
            resolved,
            dunce::canonicalize(&sub).unwrap().to_string_lossy()
        );
    }

    #[test]
    fn test_resolve_dotdot_path() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("a").join("b");
        std::fs::create_dir_all(&cwd).unwrap();

        let resolved = resolve_skill_path("../..", &cwd.to_string_lossy());
        assert_eq!(
            resolved,
            dunce::canonicalize(tmp.path()).unwrap().to_string_lossy()
        );
    }

    /// Pin both HOME and USERPROFILE to the temp dir; `xai_dirs::home_dir()` prefers USERPROFILE on Windows.
    /// Remote sandboxes (missing HOME, symlink-resolved homes, a pre-existing ~/my-skills) can make `starts_with($HOME)` fail spuriously.
    /// Serial because env mutation is process-global.
    #[test]
    #[serial_test::serial]
    fn test_resolve_tilde_path() {
        use xai_grok_test_support::env::EnvGuard;

        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        let _home = EnvGuard::set("HOME", &home);
        let _userprofile = EnvGuard::set("USERPROFILE", &home);
        let resolved = resolve_skill_path("~/my-skills", "/ignored");
        let expected = home.join("my-skills");
        assert_eq!(
            std::path::PathBuf::from(&resolved),
            expected,
            "resolved={resolved}"
        );
    }

    #[test]
    fn test_config_response_camel_case() {
        let resp = SkillsConfigResponse {
            paths: vec!["/a".into()],
            ignore: vec![],
            total_skills: 5,
            message: "ok".to_string(),
            skills: vec![],
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json.get("totalSkills"), Some(&serde_json::json!(5)));
        assert!(json.get("paths").is_some_and(|p| p.is_array()));
    }

    /// The three states Settings renders, for a skill the compiled table ships.
    #[test]
    fn default_view_reads_absent_unmodified_and_modified() {
        let tmp = tempfile::tempdir().unwrap();
        let shipped = skill_defaults::default_for("review").unwrap();

        let absent = skill_default_view_at(tmp.path(), "review");
        assert!(absent.has_default);
        assert_eq!(absent.state, "absent");
        assert!(absent.content.is_none());
        assert_eq!(absent.default, shipped);
        assert!(absent.path.ends_with("/review/SKILL.md"));

        let path = skill_defaults::user_copy_path_at(tmp.path(), "review").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, shipped).unwrap();
        assert_eq!(skill_default_view_at(tmp.path(), "review").state, "unmodified");

        std::fs::write(&path, "my rewrite\n").unwrap();
        let modified = skill_default_view_at(tmp.path(), "review");
        assert_eq!(modified.state, "modified");
        assert_eq!(modified.content.as_deref(), Some("my rewrite\n"));
    }

    /// A skill the user wrote carries no default, and no path is built from its name.
    #[test]
    fn default_view_reports_no_default_for_a_skill_cook_does_not_ship() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["my-own-skill", "", "../escape"] {
            let view = skill_default_view_at(tmp.path(), name);
            assert!(!view.has_default, "{name} ships no default");
            assert_eq!(view.path, "", "{name} must not resolve a path");
            assert_eq!(view.state, "absent");
            assert!(view.content.is_none());
            assert_eq!(view.default, "");
        }
    }

    #[test]
    fn restore_writes_the_shipped_body_byte_for_byte() {
        let tmp = tempfile::tempdir().unwrap();
        let path = skill_defaults::user_copy_path_at(tmp.path(), "review").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "my rewrite\n").unwrap();

        let result = restore_skill_default_at(tmp.path(), "review").unwrap();

        assert_eq!(result.name, "review");
        assert_eq!(result.state, "unmodified");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            skill_defaults::default_for("review").unwrap()
        );
    }

    /// Both refusals leave the tree exactly as they found it.
    #[test]
    fn restore_refuses_without_a_default_or_without_a_user_copy() {
        let tmp = tempfile::tempdir().unwrap();

        let error = restore_skill_default_at(tmp.path(), "my-own-skill").unwrap_err();
        assert!(error.to_string().contains("no default to restore"), "got: {error}");
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);

        let error = restore_skill_default_at(tmp.path(), "review").unwrap_err();
        assert!(error.to_string().contains("nothing to reset"), "got: {error}");
        assert!(!tmp.path().join("review").exists());

        // A name that tries to climb out of the skills root is refused the same way.
        let error = restore_skill_default_at(tmp.path(), "../../etc").unwrap_err();
        assert!(error.to_string().contains("no default to restore"), "got: {error}");
        assert!(!tmp.path().parent().unwrap().join("etc").exists());
    }

    #[test]
    fn default_view_serializes_camel_case() {
        let tmp = tempfile::tempdir().unwrap();
        let json = serde_json::to_value(skill_default_view_at(tmp.path(), "review")).unwrap();
        assert_eq!(json.get("hasDefault"), Some(&serde_json::json!(true)));
        assert!(json.get("default").is_some_and(|v| v.is_string()));
        let json = serde_json::to_value(skill_default_view_at(tmp.path(), "mine")).unwrap();
        assert_eq!(json.get("hasDefault"), Some(&serde_json::json!(false)));
    }
}
