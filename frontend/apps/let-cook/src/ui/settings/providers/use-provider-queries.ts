import { useQuery } from "@tanstack/react-query";
import { request } from "../../../acp/host";
import { isVisibleProviderPreset, PROVIDER_PRESETS } from "../../../acp/provider-presets";
import { listProviders, providerPresets } from "../../../acp/providers";

/** Agent presets win; the bundled mirror keeps the cards usable offline. */
export function useProviderPresets() {
  const query = useQuery({
    queryKey: ["provider-presets"],
    queryFn: providerPresets,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
  const bundled = PROVIDER_PRESETS.filter(isVisibleProviderPreset);
  const live = new Map((query.data?.presets ?? []).filter(isVisibleProviderPreset).map((preset) => [preset.id, preset]));
  const presets = bundled.map((preset) => live.get(preset.id) ?? preset);
  return { presets, isLoading: query.isLoading, isFetching: query.isFetching };
}

export function useProviders(connected: boolean) {
  return useQuery({
    queryKey: ["providers"],
    queryFn: listProviders,
    enabled: connected,
    // App shell already caches this; settings must refetch so the long models load shows a spinner.
    staleTime: 0,
    retry: 0,
  });
}

/** The signed-in Cook account behind the x.ai card's connect badge. */
export function useAuthInfo(connected: boolean) {
  return useQuery({
    queryKey: ["auth-info", "settings"],
    queryFn: () => request<{ methodId?: string | null; email?: string | null }>("x.ai/auth/info"),
    enabled: connected,
    retry: 0,
  });
}
