import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./ui/app-shell";
import { ThemeProvider } from "./ui/theme/theme";
import "./theme/app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppShell />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
