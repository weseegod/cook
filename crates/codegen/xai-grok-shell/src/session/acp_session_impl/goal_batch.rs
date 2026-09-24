//! Session-only integration for explicit `/goal_batch`.
//! Ordinary goals and auxiliary/subagent samplers never call this transport.

use super::*;

impl SessionActor {
    pub(super) async fn setup_goal_batch(
        &self,
        objective: String,
        token_budget: Option<i64>,
        plan_source: Option<crate::session::slash_commands::GoalPlanSource>,
        batch_base_url: Option<String>,
    ) -> GoalSetupOutcome {
        if objective.is_empty() {
            return GoalSetupOutcome::Message(
                "Usage: /goal_batch <objective> [--base-url <provider Batch URL>]".into(),
            );
        }
        let model_id = self.models_manager.current_model_id().0.to_string();
        let proxy = match self
            .build_goal_batch_proxy(&model_id, batch_base_url.as_deref())
            .await
        {
            Ok(proxy) => proxy,
            Err(error) => {
                return GoalSetupOutcome::Message(format!("Cannot start /goal_batch: {error}"));
            }
        };
        let previous_goal_id = self
            .goal_tracker
            .lock()
            .snapshot()
            .map(|goal| goal.goal_id.clone());
        let outcome = self.setup_goal(&objective, token_budget, plan_source).await;
        let created = {
            let mut tracker = self.goal_tracker.lock();
            let created = tracker.snapshot_mut().is_some_and(|goal| {
                if previous_goal_id.as_deref() == Some(goal.goal_id.as_str()) {
                    return false;
                }
                goal.batch = Some(crate::session::goal_tracker::GoalBatchSpec {
                    model_id,
                    base_url: batch_base_url,
                });
                true
            });
            if created {
                tracker.batch_proxy = Some(proxy);
                self.goal_notify_sender().persist_goal_state(&tracker);
            }
            created
        };
        if created && matches!(outcome, GoalSetupOutcome::Inference { .. }) {
            self.send_slash_command_output(
                "Batch mode active for the main agent; goal roles and subagents may use realtime. Each main model round waits for a Batch API job.",
            )
            .await;
        }
        outcome
    }

    pub(super) async fn restore_goal_batch_for_resume(&self) -> Result<(), String> {
        let spec = self
            .goal_tracker
            .lock()
            .snapshot()
            .and_then(|goal| goal.batch.clone());
        let Some(spec) = spec else {
            return Ok(());
        };
        let selected = self.models_manager.current_model_id().0.to_string();
        if selected != spec.model_id {
            return Err(format!(
                "select model {} before resuming this batch goal",
                spec.model_id
            ));
        }
        if self.goal_tracker.lock().batch_proxy.is_none() {
            let proxy = self
                .build_goal_batch_proxy(&spec.model_id, spec.base_url.as_deref())
                .await
                .map_err(|error| error.to_string())?;
            self.goal_tracker.lock().batch_proxy = Some(proxy);
        }
        Ok(())
    }

    pub(super) fn goal_batch_status_suffix(&self) -> String {
        let tracker = self.goal_tracker.lock();
        if !tracker.snapshot().is_some_and(|goal| goal.batch.is_some()) {
            return String::new();
        }
        let mut suffix = "\nMode: Batch API (main agent)".to_string();
        match tracker.batch_proxy.as_ref() {
            Some(proxy) => {
                if let Some(job_id) = proxy.current_job_id() {
                    suffix.push_str(&format!("\nCurrent batch job: {job_id}"));
                }
            }
            None => suffix.push_str("\nBatch transport inactive; use /goal resume."),
        }
        suffix
    }

    pub(super) async fn build_goal_batch_proxy(
        &self,
        model_id: &str,
        batch_base_url: Option<&str>,
    ) -> anyhow::Result<crate::sampling::goal_batch::GoalBatchProxy> {
        let config = crate::config::load_agent_config_disk_only().map_err(anyhow::Error::msg)?;
        let sampler_config = self.reconstruct_full_config().await;
        let client = crate::sampling::goal_batch::BatchClient::from_config(
            &config,
            model_id,
            batch_base_url,
        )?;
        if sampler_config.api_backend != xai_grok_sampling_types::ApiBackend::ChatCompletions
            || sampler_config.model != client.model_slug()
        {
            anyhow::bail!(
                "/goal_batch requires a Chat Completions model matching the selected model"
            );
        }
        crate::sampling::goal_batch::GoalBatchProxy::start(client).await
    }

    /// Called only by the main turn's sampler preparation. A persisted batch
    /// marker without a live proxy must fail closed, never contact realtime.
    pub(super) fn apply_goal_batch_route(&self, config: &mut xai_grok_sampler::SamplerConfig) {
        let route = {
            let tracker = self.goal_tracker.lock();
            let active = tracker.snapshot().is_some_and(|goal| {
                goal.status == crate::session::goal_tracker::GoalStatus::Active
                    && goal.batch.is_some()
            });
            if !active {
                return;
            }
            tracker
                .batch_proxy
                .as_ref()
                .map(|proxy| (proxy.base_url().to_owned(), proxy.bearer().to_owned()))
        };
        if route.is_none() {
            tracing::error!("batch goal has no live transport; refusing realtime fallback");
        }
        route_batch_sampler_config(
            config,
            route
                .as_ref()
                .map(|(url, bearer)| (url.as_str(), bearer.as_str())),
        );
    }
}

fn route_batch_sampler_config(
    config: &mut xai_grok_sampler::SamplerConfig,
    route: Option<(&str, &str)>,
) {
    config.base_url = route
        .map_or("http://127.0.0.1:9/v1", |(url, _)| url)
        .to_owned();
    config.api_key = route.map(|(_, bearer)| bearer.to_owned());
    config.api_backend = xai_grok_sampling_types::ApiBackend::ChatCompletions;
    config.auth_scheme = xai_grok_sampler::AuthScheme::Bearer;
    config.bearer_resolver = None;
    config.attribution_callback = None;
    config.mtls_cert_dir = None;
    config.extra_headers.clear();
    config.env_http_headers.clear();
    config.query_params.clear();
    config.extra_response_includes.clear();
    config.supports_backend_search = false;
    config.request_compression = xai_grok_sampler::RequestCompression::None;
    config.compactions_remaining = None;
    config.compaction_at_tokens = None;
    config.max_retries = Some(0);
    // One dependent batch round may take the provider's whole completion window.
    config.idle_timeout_secs = Some(25 * 60 * 60);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_route_scrubs_provider_auth_and_fails_closed_without_proxy() {
        let mut config = xai_grok_sampler::SamplerConfig {
            api_key: Some("provider-secret".into()),
            base_url: "https://provider.example/v1".into(),
            model: "test-model".into(),
            extra_headers: [("x-provider-key".into(), "secret".into())]
                .into_iter()
                .collect(),
            query_params: [("api_key".into(), "secret".into())].into_iter().collect(),
            ..Default::default()
        };
        route_batch_sampler_config(&mut config, Some(("http://127.0.0.1:1234/v1", "local")));
        assert_eq!(config.base_url, "http://127.0.0.1:1234/v1");
        assert_eq!(config.api_key.as_deref(), Some("local"));
        assert!(config.extra_headers.is_empty());
        assert!(config.query_params.is_empty());
        assert_eq!(config.max_retries, Some(0));
        route_batch_sampler_config(&mut config, None);
        assert_eq!(config.base_url, "http://127.0.0.1:9/v1");
        assert!(config.api_key.is_none());
    }
}
