import { oauthProviderName } from "../../../acp/provider-presets";

export { isOauthProvider, oauthProviderName } from "../../../acp/provider-presets";

/**
 * SVG marks live in `public/providers/{id}.svg` so path data is not duplicated in the
 * component. IDs without a file fall back to initials. To add a logo: drop
 * `/public/providers/{id}.svg` and list the id below.
 */
const PROVIDER_LOGO_IDS = new Set([
  "openai",
  "anthropic",
  "xai",
  "deepseek",
  "openrouter",
  "xiaomi",
]);

/** Display class used by tests and the theme when it differs from the provider id. */
const PROVIDER_LOGO_CLASS: Record<string, string> = {
  anthropic: "claude",
  xai: "grok",
};

export function providerLogoSrc(id: string): string | null {
  if (!PROVIDER_LOGO_IDS.has(id)) return null;
  return `/providers/${id}.svg`;
}

export function ProviderLogo({ id, size = 22, label }: { id: string; size?: number; label?: string }) {
  const title = label ?? oauthProviderName(id);
  const src = providerLogoSrc(id);
  if (src) {
    const modifier = PROVIDER_LOGO_CLASS[id] ?? id;
    return (
      <span
        className={`provider-logo provider-logo-${modifier}`}
        style={{ width: size, height: size, ["--provider-logo-url" as string]: `url("${src}")` }}
        role="img"
        aria-label={title}
        title={title}
      />
    );
  }
  const initials = (label ?? id).slice(0, 2).toUpperCase();
  return (
    <span className="provider-logo provider-logo-fallback" style={{ width: size, height: size }} aria-hidden>
      {initials}
    </span>
  );
}
