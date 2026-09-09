//! Server-driven gate imposition/lift.
//!
//! The fork removes the consumer free→paid paywall (BYOK sessions have no
//! grok.com billing), but keeps the gate chokepoint: a gate can still arrive
//! from remote settings (`grok_build_settings.gate_message`), and it must
//! render and lift through one place. `impose_gate` shows directly — the
//! consumer "defer while a live subscription check verifies" dance is gone.

use super::actions::Effect;
use super::app_view::AppView;

/// Kept so upstream `Effect::ScheduleGateVerifyTimeout` wiring still compiles;
/// the fork never schedules that deferral path from [`AppView::impose_gate`].
pub(crate) const GATE_VERIFY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

impl AppView {
    /// Chokepoint for showing a gate. Already gated → update the copy.
    /// Otherwise show directly (no consumer deferral — see module docs).
    #[must_use]
    pub fn impose_gate(&mut self, gate: xai_grok_login::GateInfo) -> Vec<Effect> {
        self.pending_gate_verification = None;
        if self.gate.is_some() {
            self.gate = Some(gate);
            return vec![];
        }
        crate::unified_log::info(
            "subscription.gate.imposed",
            None,
            Some(serde_json::json!({ "deferred": false })),
        );
        self.gate = Some(gate);
        vec![]
    }

    /// Chokepoint for a settings-confirmed gate lift. Clears the visible
    /// gate and runs the lift bookkeeping (re-focus the welcome prompt).
    #[must_use]
    pub fn lift_gate(&mut self) -> Vec<Effect> {
        let was_blocked = self.gate.is_some() || self.pending_gate_verification.is_some();
        self.gate = None;
        self.pending_gate_verification = None;
        if !was_blocked {
            return vec![];
        }
        self.welcome_prompt_focused = true;
        crate::unified_log::info(
            "subscription.gate.lifted",
            None,
            Some(serde_json::json!({ "tier": self.subscription_tier })),
        );
        vec![]
    }

    /// Upstream event_loop still polls the watch cadence; BYOK fork disables it.
    pub fn subscription_watch_interval(&self) -> Option<std::time::Duration> {
        None
    }

    /// Upstream event_loop still polls this; BYOK fork never watches for free→paid.
    pub fn subscription_watch_wanted(&self) -> bool {
        false
    }

    /// Watch / focus-triggered subscription checks. BYOK fork never schedules them.
    #[must_use]
    pub fn fire_subscription_check(&mut self, _trigger: &'static str) -> Vec<Effect> {
        vec![]
    }

    /// Upstream billing still calls this after a verify timeout/failure.
    /// With no deferral path, pending is normally empty; promote if anything remains.
    pub(crate) fn promote_deferred_gate(&mut self, generation: u64, reason: &'static str) {
        if generation != self.gate_verify_gen {
            return;
        }
        let Some(gate) = self.pending_gate_verification.take() else {
            return;
        };
        crate::unified_log::info(
            "subscription.gate.promoted",
            None,
            Some(serde_json::json!({ "reason": reason, "deferred": false })),
        );
        self.gate = Some(gate);
    }
}
