use super::load::load_config_from_toml;
use super::mcp::{Config, user_config_path};
use anyhow::Result;
use std::path::Path;
use toml::Value as TomlValue;
use toml::map::Map as TomlMap;
use xai_grok_agent::prompt::skills::SkillsConfig;
use xai_grok_config::SKILLS_CONFIG_FILENAME;
use xai_grok_config::fs_atomic::BoundDest;

fn read_skills_config(path: &Path) -> Result<Option<SkillsConfig>> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let value = parse_existing_config_toml(&contents)?;
    Ok(Some(value.try_into()?))
}
/// Process-wide write lock for `~/.grok/config.toml`.
/// Serializes the read-modify-write in `save_config` so two rapid settings toggles can't interleave and clobber each other.
static SAVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Blank (first-run 0-byte file) is an empty table; other unparseable TOML is an error so a silent fallback cannot drop unmodeled sections.
pub(crate) fn parse_existing_config_toml(s: &str) -> Result<TomlValue, toml::de::Error> {
    if s.trim().is_empty() {
        return Ok(TomlValue::Table(TomlMap::new()));
    }
    toml::from_str(s)
}
/// Settings-save body. Caller must hold [`ConfigWriteGuard`].
/// Re-resolve `dest` before publish. A retarget must not merge A onto B.
async fn save_config_locked(
    guard: ConfigWriteGuard,
    slot: &Path,
    dest: BoundDest,
    skills_dest: BoundDest,
    config: &Config,
) -> Result<()> {
    let dest = require_same_user_config_dest(slot, &dest)?;
    let mut root: TomlValue = match tokio::fs::read_to_string(dest.as_path()).await {
        Ok(s) => match parse_existing_config_toml(&s) {
            Ok(v) => v,
            Err(parse_err) => {
                return Err(anyhow::anyhow!(
                    "refusing to overwrite unparseable {}: {}; save a backup \
                         and fix the syntax error before retrying",
                    slot.display(),
                    parse_err,
                ));
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => TomlValue::Table(TomlMap::new()),
        Err(e) => {
            return Err(anyhow::anyhow!(
                "refusing to overwrite unreadable {}: {e}",
                slot.display()
            ));
        }
    };
    if !matches!(root, TomlValue::Table(_)) {
        root = TomlValue::Table(TomlMap::new());
    }
    let table = root.as_table_mut().expect("root must be a table");
    merge_section(table, "cli", &config.cli);
    merge_section(table, "models", &config.models);
    merge_section(table, "ui", &config.ui);
    merge_section(table, "harness", &config.harness);
    merge_section(table, "session", &config.session);
    merge_ask_user_question_section(table, &config.ask_user_question);
    if config.privacy == super::mcp::PrivacyConfig::default() {
        table.remove("privacy");
    } else {
        merge_section(table, "privacy", &config.privacy);
    }
    if config.consent == super::consent::ConsentConfig::default() {
        table.remove("consent");
    } else {
        if let Some(TomlValue::Table(section)) = table.get_mut("consent") {
            section.remove("answers");
        }
        merge_section(table, "consent", &config.consent);
    }
    let had_legacy_skills = table.remove("skills").is_some();
    merge_section(table, "telemetry", &config.telemetry);
    merge_section(table, "features", &config.features);
    let toml_str = toml::to_string_pretty(&root)?;
    let dest = require_same_user_config_dest(slot, &dest)?;
    let slot = slot.to_path_buf();
    let skills_slot = slot.with_file_name(SKILLS_CONFIG_FILENAME);
    let skills_dest = require_same_user_config_dest(&skills_slot, &skills_dest)?;
    let old_skills = read_to_string_or_empty(skills_dest.as_path())?;
    let mut skills_root = parse_existing_config_toml(&old_skills)?;
    if !matches!(skills_root, TomlValue::Table(_)) {
        return Err(anyhow::anyhow!(
            "{} root is not a table",
            skills_slot.display()
        ));
    }
    let write_skills =
        !old_skills.is_empty() || had_legacy_skills || config.skills != SkillsConfig::default();
    if write_skills {
        skills_root
            .as_table_mut()
            .expect("checked above")
            .remove("disabled");
        merge_toml_tables(
            skills_root.as_table_mut().expect("checked above"),
            TomlValue::try_from(&config.skills)?
                .as_table()
                .expect("SkillsConfig serializes to a table")
                .clone(),
        );
    }
    let skills_toml = write_skills
        .then(|| toml::to_string_pretty(&skills_root))
        .transpose()?;
    guard
        .run_blocking(move || -> std::io::Result<()> {
            if let Some(skills_toml) = skills_toml {
                let skills_dest = require_same_user_config_dest(&skills_slot, &skills_dest)?;
                atomic_write_resolved_string(&skills_dest, &skills_toml)?;
            }
            let dest = require_same_user_config_dest(&slot, &dest)?;
            atomic_write_resolved_string(&dest, &toml_str)
        })
        .await
        .map_err(|e| anyhow::anyhow!("config write task failed: {e}"))??;
    Ok(())
}
/// Guard for a user `config.toml` read-modify-write: [`SAVE_LOCK`] plus the config-init flock —
/// without the flock leg, a SAVE_LOCK writer and a flock writer silently drop each other's edits.
#[must_use]
pub(crate) struct ConfigWriteGuard {
    _save: tokio::sync::MutexGuard<'static, ()>,
    _flock: std::fs::File,
}
impl ConfigWriteGuard {
    /// Run `f` on the blocking pool with this guard living in that task.
    /// Cancelling the returned future must not drop the guard in the async frame.
    pub(crate) async fn run_blocking<T, F>(self, f: F) -> Result<T, tokio::task::JoinError>
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        tokio::task::spawn_blocking(move || {
            let _guard = self;
            f()
        })
        .await
    }
}
/// Acquire the user `config.toml` write guard (SAVE_LOCK ⊃ init flock) on the blocking pool;
/// fails closed — callers must not fall back to an unguarded write.
/// `SAVE_LOCK` moves into that task so a cancelled await cannot release it while flock is still being acquired.
pub(crate) async fn lock_config_writes() -> std::io::Result<ConfigWriteGuard> {
    let save = SAVE_LOCK.lock().await;
    let grok_home = crate::util::grok_home::grok_home();
    tokio::task::spawn_blocking(move || {
        let flock = acquire_init_lock(&grok_home)?;
        Ok(ConfigWriteGuard {
            _save: save,
            _flock: flock,
        })
    })
    .await
    .map_err(|e| std::io::Error::other(format!("config lock task failed: {e}")))?
}
/// Exclusive advisory `flock` on `<grok_home>/.config-init.lock`, retried briefly, serializing
/// `config.toml` read-modify-writes; only `WouldBlock` retries, and the file is never removed.
pub fn acquire_init_lock(grok_home: &std::path::Path) -> std::io::Result<std::fs::File> {
    use fs2::FileExt;
    let _ = std::fs::create_dir_all(grok_home);
    let lock_path = grok_home.join(".config-init.lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)?;
    for _ in 0..50 {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::WouldBlock,
        format!("timed out waiting for {} after 1s", lock_path.display()),
    ))
}
/// Read a file, treating only `NotFound` as empty.
/// Hard read errors (EACCES, EIO) propagate so callers don't clobber an unreadable file on the next write.
pub fn read_to_string_or_empty(path: &std::path::Path) -> std::io::Result<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e),
    }
}
/// Bind the follow dest then read it. Pair with [`atomic_write_follow_bound`].
pub fn read_follow_bound(path: &std::path::Path) -> std::io::Result<(BoundDest, String)> {
    let dest = bind_user_config_dest(path)?;
    let content = read_to_string_or_empty(dest.as_path())?;
    Ok((dest, content))
}
fn bind_user_config_dest(path: &std::path::Path) -> std::io::Result<BoundDest> {
    bind_user_config_dest_with(path, true, xai_grok_config::user_grok_home().is_some())
}
fn bind_user_config_dest_with(
    path: &std::path::Path,
    follow_leaf: bool,
    has_user_home: bool,
) -> std::io::Result<BoundDest> {
    if follow_leaf && has_user_home {
        xai_grok_config::fs_atomic::bind_follow_destination(path)
    } else {
        xai_grok_config::fs_atomic::bind_slot_destination(path)
    }
}
/// Re-resolve with the same follow/slot policy used to bind `dest`.
pub(crate) fn require_same_user_config_dest(
    slot: &std::path::Path,
    dest: &BoundDest,
) -> std::io::Result<BoundDest> {
    require_same_user_config_dest_with(slot, dest, xai_grok_config::user_grok_home().is_some())
}
fn require_same_user_config_dest_with(
    slot: &std::path::Path,
    dest: &BoundDest,
    has_user_home: bool,
) -> std::io::Result<BoundDest> {
    let now = bind_user_config_dest_with(slot, true, has_user_home)?;
    if now != *dest {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "config destination for {} changed from {} to {}",
                slot.display(),
                dest.as_path().display(),
                now.as_path().display()
            ),
        ));
    }
    Ok(now)
}
/// Publish onto `dest` only if `slot` still resolves to it.
pub fn atomic_write_follow_bound(
    slot: &std::path::Path,
    dest: &BoundDest,
    content: &str,
) -> std::io::Result<()> {
    let dest = require_same_user_config_dest(slot, dest)?;
    atomic_write_resolved_string(&dest, content)
}
/// Atomic write via temp file then `rename`. Follows a leaf symlink.
/// Project `.grok/config.toml` must use [`atomic_replace_string`].
/// User-config RMW must bind dest before load ([`read_follow_bound`] + [`atomic_write_follow_bound`]).
pub fn atomic_write_string(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    atomic_write_string_inner(path, content, true)
}
/// Like [`atomic_write_string`], but `rename` replaces a leaf symlink inode.
pub fn atomic_replace_string(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    atomic_write_string_inner(path, content, false)
}
/// Follow-leaf bind + read. Caller already classified `path` as user `config.toml`.
pub fn read_follow_leaf(path: &std::path::Path) -> std::io::Result<(BoundDest, String)> {
    let dest = xai_grok_config::fs_atomic::bind_follow_destination(path)?;
    let content = read_to_string_or_empty(dest.as_path())?;
    Ok((dest, content))
}
/// Follow-leaf publish if `slot` still resolves to `dest`.
pub fn atomic_write_follow_leaf(
    slot: &std::path::Path,
    dest: &BoundDest,
    content: &str,
) -> std::io::Result<()> {
    let dest = xai_grok_config::fs_atomic::require_same_bound_destination(slot, dest)?;
    atomic_write_resolved_string(&dest, content)
}
fn atomic_write_string_inner(
    path: &std::path::Path,
    content: &str,
    follow_leaf: bool,
) -> std::io::Result<()> {
    let dest = if follow_leaf {
        let first = xai_grok_config::fs_atomic::bind_follow_destination(path)?;
        xai_grok_config::fs_atomic::require_same_bound_destination(path, &first)?
    } else {
        xai_grok_config::fs_atomic::bind_slot_destination(path)?
    };
    atomic_write_resolved_string(&dest, content)
}
/// Publish onto an already-bound destination. Temp inherits the current dest mode.
pub(crate) fn atomic_write_resolved_string(dest: &BoundDest, content: &str) -> std::io::Result<()> {
    if let Some(parent) = dest.as_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    xai_grok_config::fs_atomic::write_atomically_bound(dest, content, None)
}
/// Merge `[toolset.ask_user_question]` into the root table.
/// `[toolset]` is deliberately NOT merged wholesale, so only this settings-writable sub-table round-trips.
/// It carries runtime-only structs (`web_search` sampler etc.) whose serialized defaults must never land in the user file.
fn merge_ask_user_question_section(
    table: &mut TomlMap<String, TomlValue>,
    ask: &crate::tools::config::AskUserQuestionToolConfig,
) {
    if ask.timeout_enabled.is_none() && ask.timeout_secs.is_none() {
        return;
    }
    let toolset = table
        .entry("toolset".to_string())
        .or_insert_with(|| TomlValue::Table(TomlMap::new()));
    if !matches!(toolset, TomlValue::Table(_)) {
        *toolset = TomlValue::Table(TomlMap::new());
    }
    if let TomlValue::Table(toolset_table) = toolset {
        merge_section(toolset_table, "ask_user_question", ask);
    }
}
/// Merge serialized fields of `value` into `table[key]`, preserving any existing keys not present in the serialized output.
/// This prevents `save_config` round-trips from silently dropping unmodeled fields (e.g. pager-written `show_timestamps`, `auto_dark_theme`).
/// Deep-merge `incoming` into `existing`: nested tables recurse; scalars replace.
fn merge_toml_tables(
    existing: &mut TomlMap<String, TomlValue>,
    incoming: TomlMap<String, TomlValue>,
) {
    for (field_key, field_val) in incoming {
        match (existing.get_mut(&field_key), field_val) {
            (Some(TomlValue::Table(dst)), TomlValue::Table(src)) => {
                merge_toml_tables(dst, src);
            }
            (_, v) => {
                existing.insert(field_key, v);
            }
        }
    }
}
fn merge_section<T: serde::Serialize>(
    table: &mut TomlMap<String, TomlValue>,
    key: &str,
    value: &T,
) {
    match TomlValue::try_from(value) {
        Ok(TomlValue::Table(new_fields)) if !new_fields.is_empty() => {
            let section = table
                .entry(key.to_string())
                .or_insert_with(|| TomlValue::Table(TomlMap::new()));
            if let TomlValue::Table(existing) = section {
                merge_toml_tables(existing, new_fields);
            } else {
                *section = TomlValue::Table(new_fields);
            }
        }
        Ok(TomlValue::Table(_)) => {}
        Ok(_) | Err(_) => {
            table.remove(key);
        }
    }
}
/// Update settings with a read-modify-write, preserving unrelated fields.
pub async fn update_config<F>(f: F) -> Result<()>
where
    F: FnOnce(&mut Config),
{
    let guard = lock_config_writes().await?;
    let path = user_config_path();
    let dest = bind_user_config_dest(&path)?;
    let root: TomlValue = crate::config::load_config_file(dest.as_path())?;
    let mut cfg = load_config_from_toml(&root);
    let skills_path = path.with_file_name(SKILLS_CONFIG_FILENAME);
    let skills_dest = bind_user_config_dest(&skills_path)?;
    if let Some(skills) = read_skills_config(skills_dest.as_path())? {
        cfg.skills = skills;
    }
    f(&mut cfg);
    cfg.skills.migrate_disabled();
    save_config_locked(guard, &path, dest, skills_dest, &cfg).await
}

/// Record all discovered names in skills.toml without resetting explicit preferences.
/// Repeated discovery does not write, preventing watcher/reload feedback loops.
pub async fn sync_skills_status(
    skills: &[xai_grok_agent::prompt::skills::SkillInfo],
) -> Result<()> {
    let guard = lock_config_writes().await?;
    let slot = user_config_path().with_file_name(SKILLS_CONFIG_FILENAME);
    let (dest, content) = read_follow_bound(&slot)?;
    let mut root = parse_existing_config_toml(&content)?;
    let mut config = if content.trim().is_empty() {
        load_config_from_toml(&crate::config::load_config_file(&user_config_path())?).skills
    } else {
        root.clone().try_into::<SkillsConfig>()?
    };
    let previous = config.clone();
    config.record_discovered(
        skills
            .iter()
            .map(|skill| (skill.name.clone(), skill.enabled)),
    );
    if config == previous && !content.trim().is_empty() {
        return Ok(());
    }
    let table = root
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("skills root is not a table"))?;
    table.remove("disabled");
    merge_toml_tables(
        table,
        TomlValue::try_from(&config)?.as_table().unwrap().clone(),
    );
    let contents = toml::to_string_pretty(&root)?;
    guard
        .run_blocking(move || atomic_write_follow_bound(&slot, &dest, &contents))
        .await??;
    Ok(())
}

/// Move the old user `[skills]` table into the dedicated file on startup.
/// Writing the new file first keeps the skill preferences available if the
/// second atomic write fails.
pub fn migrate_legacy_skills_config(grok_home: &Path) -> Result<()> {
    let _lock = acquire_init_lock(grok_home)?;
    let config_slot = grok_home.join("config.toml");
    let (config_dest, content) = read_follow_bound(&config_slot)?;
    let mut config = parse_existing_config_toml(&content)?;
    let legacy = config.get("skills").cloned();
    if legacy.as_ref().is_some_and(|value| !value.is_table()) {
        return Err(anyhow::anyhow!("legacy [skills] is not a table"));
    }
    let skills_slot = grok_home.join(SKILLS_CONFIG_FILENAME);
    let (skills_dest, skills_content) = read_follow_bound(&skills_slot)?;
    let mut skills = if skills_content.trim().is_empty() {
        match legacy.clone() {
            Some(value) => value,
            None => return Ok(()),
        }
    } else {
        parse_existing_config_toml(&skills_content)?
    };
    let mut parsed: SkillsConfig = skills.clone().try_into()?;
    parsed.migrate_disabled();
    let table = skills
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("skills root is not a table"))?;
    table.remove("disabled");
    merge_toml_tables(
        table,
        TomlValue::try_from(&parsed)?.as_table().unwrap().clone(),
    );
    let contents = toml::to_string_pretty(&skills)?;
    if contents != skills_content {
        atomic_write_follow_bound(&skills_slot, &skills_dest, &contents)?;
    }
    if legacy.is_none() {
        return Ok(());
    }

    config
        .as_table_mut()
        .expect("config is a table")
        .remove("skills");
    atomic_write_follow_bound(
        &config_slot,
        &config_dest,
        &toml::to_string_pretty(&config)?,
    )?;
    Ok(())
}
#[cfg(test)]
#[path = "persist_tests.rs"]
mod tests;
