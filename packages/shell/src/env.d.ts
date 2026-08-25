/// <reference types="astro/client" />

declare global {
  interface Window {
    /**
     * Launch an app by id. Installed on `window` by the shell (index.astro)
     * and by the standalone launcher page, and called from UI fragments that
     * are rendered inside those pages (the app drawer, the dock).
     *
     * Optional because it only exists once the installing script has run —
     * callers must use `window.auraLaunchApp?.(…)` rather than assume it.
     */
    auraLaunchApp?: (appId: string, opts?: { workspaceId?: string }) => Promise<void> | void;
  }
}

export {};
