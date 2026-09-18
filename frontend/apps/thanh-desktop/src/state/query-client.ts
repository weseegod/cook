import { QueryClient } from "@tanstack/react-query";

/** Shared QueryClient so ACP notification handlers can invalidate UI queries outside React. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});
