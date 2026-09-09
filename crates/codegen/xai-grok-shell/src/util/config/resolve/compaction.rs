/// Default auto-compact threshold (% of context window) when no source sets it.
pub const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT: u8 = 85;

/// Env pin for the session context window (tokens). Wins over user TOML.
pub(crate) const ENV_DEBUG_CONTEXT_WINDOW: &str = "GROK_DEBUG_CONTEXT_WINDOW";

/// Process-wide context-window pin from [`ENV_DEBUG_CONTEXT_WINDOW`].
pub(crate) fn debug_context_window_override() -> Option<std::num::NonZeroU64> {
    std::env::var(ENV_DEBUG_CONTEXT_WINDOW)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .and_then(std::num::NonZeroU64::new)
}

/// Explicit `[model.<id>].context_window` from user/managed TOML, if set.
///
/// Lookup is by catalog key first, then by routing slug (`model = "..."`).
/// Used to pin auto-compact against `x-grok-context-window` header upgrades.
pub(crate) fn user_context_window_override(
    cfg: &crate::agent::config::Config,
    model_id: &str,
) -> Option<std::num::NonZeroU64> {
    let from_entry = |m: &crate::agent::config::ConfigModelOverride| {
        m.context_window.and_then(std::num::NonZeroU64::new)
    };
    if let Some(cw) = cfg.config_models.get(model_id).and_then(from_entry) {
        return Some(cw);
    }
    cfg.config_models.iter().find_map(|(key, m)| {
        let slug = m.model.as_deref().unwrap_or(key.as_str());
        (slug == model_id).then(|| from_entry(m)).flatten()
    })
}

/// Debug env wins; otherwise a user/managed `[model.<id>].context_window`.
pub(crate) fn resolve_context_window_pin(
    cfg: &crate::agent::config::Config,
    model_id: &str,
) -> Option<std::num::NonZeroU64> {
    debug_context_window_override().or_else(|| user_context_window_override(cfg, model_id))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CompactionToolChoice {
    #[default]
    Auto,
    None,
}

impl std::str::FromStr for CompactionToolChoice {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "none" => Ok(Self::None),
            _ => Err(()),
        }
    }
}

pub(crate) const ENV_COMPACTION_TOOL_CHOICE: &str = "GROK_COMPACTION_TOOL_CHOICE";

pub(crate) fn resolve_compaction_tool_choice_from(
    env: Option<&str>,
    config: Option<&str>,
    remote: Option<&str>,
) -> CompactionToolChoice {
    env.and_then(|s| s.parse().ok())
        .or_else(|| config.and_then(|s| s.parse().ok()))
        .or_else(|| remote.and_then(|s| s.parse().ok()))
        .unwrap_or_default()
}

pub(crate) const ENV_AUTO_COMPACT_THRESHOLD_PERCENT: &str = "GROK_AUTO_COMPACT_THRESHOLD_PERCENT";

/// Precedence (highest first): env `GROK_AUTO_COMPACT_THRESHOLD_PERCENT` user TOML `[model.<id>].auto_compact_threshold_percent` (`cfg.config_models`, the merge of user and managed `[model.<id>]` sections) user TOML `[session].auto_compact_threshold_percent` remote settings per-model `ModelInfo.auto_compact_threshold_percent` (kept out of `ConfigModelOverride::apply` so the user and remote per-model tiers stay distinct) remote settings global `RemoteSettings.auto_compact_threshold_percent` default `DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT`
pub(crate) fn resolve_auto_compact_threshold_percent(
    cfg: &crate::agent::config::Config,
    model_id: &str,
    model: Option<&crate::agent::config::ModelInfo>,
) -> u8 {
    resolve_auto_compact_threshold_percent_from_tiers(
        cfg.config_models
            .get(model_id)
            .and_then(|m| m.auto_compact_threshold_percent),
        cfg.session.auto_compact_threshold_percent,
        model.and_then(|m| m.auto_compact_threshold_percent),
        cfg.remote_settings
            .as_ref()
            .and_then(|r| r.auto_compact_threshold_percent),
    )
}

/// [`resolve_auto_compact_threshold_percent`] for callers without a `Config`, e.g. subagent spawn paths that pass the parent's tiers explicitly.
/// There the per-model tier uses the subagent's resolved model id, not the parent's.
pub(crate) fn resolve_auto_compact_threshold_percent_from_tiers(
    user_per_model: Option<u8>,
    user_global: Option<u8>,
    gb_per_model: Option<u8>,
    gb_global: Option<u8>,
) -> u8 {
    fn clamp_env(raw: i64) -> Option<u8> {
        if (0..=100).contains(&raw) {
            Some(raw as u8)
        } else {
            tracing::debug!(
                source = "env",
                value = raw,
                "auto_compact_threshold_percent out of range 0..=100; ignoring"
            );
            None
        }
    }
    let from_env = || -> Option<u8> {
        std::env::var(ENV_AUTO_COMPACT_THRESHOLD_PERCENT)
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .and_then(clamp_env)
    };

    from_env()
        .or(user_per_model)
        .or(user_global)
        .or(gb_per_model)
        .or(gb_global)
        .unwrap_or(DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT)
}

/// Fleet p99 of successful compactions is ~181s (≈225s at 400K+ input).
/// So 300s clears the legit tail with margin while cutting a runaway from the ~600s deadline.
pub const DEFAULT_COMPACTION_WALL_CLOCK_BUDGET_SECS: u64 = 300;

/// Below this, a configured budget is almost certainly a misconfig (fleet success p99 ~181s); logged at `warn`, not clamped.
const COMPACTION_WALL_CLOCK_BUDGET_WARN_SECS: u64 = 120;

const ENV_COMPACTION_WALL_CLOCK_BUDGET_SECS: &str = "GROK_COMPACTION_WALL_CLOCK_SECS";

/// Precedence: env `GROK_COMPACTION_WALL_CLOCK_SECS`, then remote `RemoteSettings.compaction_wall_clock_budget_secs`, then the client default. `0` **disables** it.
/// Low values are warned, not clamped: any "safe" clamp (e.g. 30s) would itself cut legit compactions, trading one silent failure for another. Ops own the value.
pub(crate) fn resolve_compaction_wall_clock_budget_secs(gb_global: Option<u64>) -> u64 {
    let from_env = std::env::var(ENV_COMPACTION_WALL_CLOCK_BUDGET_SECS)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok());
    let resolved = from_env
        .or(gb_global)
        .unwrap_or(DEFAULT_COMPACTION_WALL_CLOCK_BUDGET_SECS);
    if resolved > 0 && resolved < COMPACTION_WALL_CLOCK_BUDGET_WARN_SECS {
        tracing::warn!(
            budget_secs = resolved,
            "compaction wall-clock budget {resolved}s is below {COMPACTION_WALL_CLOCK_BUDGET_WARN_SECS}s \
             and may cut legitimate compactions (fleet success p99 ~181s); set 0 to disable"
        );
    }
    resolved
}

#[cfg(test)]
mod compaction_wall_clock_budget_tests {
    use super::resolve_compaction_wall_clock_budget_secs as resolve;

    // Assumes GROK_COMPACTION_WALL_CLOCK_SECS is unset in the test env.
    #[test]
    fn default_global_disable_and_no_clamp() {
        assert_eq!(resolve(None), 300); // client default
        assert_eq!(resolve(Some(450)), 450); // server global wins
        assert_eq!(resolve(Some(0)), 0); // 0 explicitly disables (no clamp)
        assert_eq!(resolve(Some(5)), 5); // low values pass through (warned, not clamped)
    }
}

#[cfg(test)]
mod compaction_tool_choice_tests {
    use super::{CompactionToolChoice, resolve_compaction_tool_choice_from as resolve};

    #[test]
    fn default_is_auto() {
        assert_eq!(resolve(None, None, None), CompactionToolChoice::Auto);
    }

    #[test]
    fn precedence_env_over_config_over_remote() {
        assert_eq!(
            resolve(Some("none"), Some("auto"), Some("auto")),
            CompactionToolChoice::None
        );
        assert_eq!(
            resolve(None, Some("none"), Some("auto")),
            CompactionToolChoice::None
        );
        assert_eq!(
            resolve(None, None, Some("none")),
            CompactionToolChoice::None
        );
    }

    #[test]
    fn garbage_falls_through() {
        assert_eq!(
            resolve(Some("garbage"), None, Some("none")),
            CompactionToolChoice::None
        );
        assert_eq!(
            resolve(Some("garbage"), Some("also-bad"), None),
            CompactionToolChoice::Auto
        );
    }

    #[test]
    fn from_str_case_insensitive() {
        assert_eq!("AUTO".parse(), Ok(CompactionToolChoice::Auto));
        assert_eq!(" None ".parse(), Ok(CompactionToolChoice::None));
        assert!("required".parse::<CompactionToolChoice>().is_err());
    }
}

#[cfg(test)]
mod user_context_window_override_tests {
    use super::user_context_window_override;
    use crate::agent::config::Config;

    fn cfg(toml: &str) -> Config {
        let raw: toml::Value = toml::from_str(toml).expect("toml");
        Config::new_from_toml_cfg(&raw).expect("config")
    }

    #[test]
    fn catalog_key_pin() {
        let c = cfg(
            r#"
            [model."grok-4.6"]
            context_window = 300000
            "#,
        );
        assert_eq!(
            user_context_window_override(&c, "grok-4.6").map(|n| n.get()),
            Some(300_000)
        );
        assert_eq!(user_context_window_override(&c, "grok-4.5"), None);
    }

    #[test]
    fn routing_slug_pin() {
        let c = cfg(
            r#"
            [model."deepseek/flash"]
            model = "deepseek-v4-flash"
            context_window = 128000
            "#,
        );
        assert_eq!(
            user_context_window_override(&c, "deepseek-v4-flash").map(|n| n.get()),
            Some(128_000)
        );
        assert_eq!(
            user_context_window_override(&c, "deepseek/flash").map(|n| n.get()),
            Some(128_000)
        );
    }

    #[test]
    fn missing_field_is_not_a_pin() {
        let c = cfg(
            r#"
            [model."grok-4.6"]
            input = ["text"]
            "#,
        );
        assert_eq!(user_context_window_override(&c, "grok-4.6"), None);
    }
}
