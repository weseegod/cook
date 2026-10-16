import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startAttentionBadge } from "./acp/attention-badge";
import { queryClient } from "./state/query-client";
import { AppShell } from "./ui/app-shell";
import { ThemeProvider } from "./ui/theme/theme";
import "./theme/app.css";

// The Dock/taskbar badge marks conversations that need the user while the window is unfocused.
startAttentionBadge();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppShell />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
