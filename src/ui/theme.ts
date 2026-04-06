import type { ThemeMode } from "../core/storage";

export function resolveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") {
    return mode;
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function applyThemeMode(mode: ThemeMode) {
  const resolvedMode = resolveThemeMode(mode);
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme = resolvedMode;
}
