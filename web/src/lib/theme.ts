import { useEffect, useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";
const KEY = "leetclaude.theme";
const query = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function readMode(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

let mode: ThemeMode = readMode();

function resolved(m: ThemeMode): "light" | "dark" {
  if (m === "system") return matchMedia(query).matches ? "dark" : "light";
  return m;
}

function apply() {
  document.documentElement.dataset.theme = resolved(mode);
  listeners.forEach((l) => l());
}

matchMedia(query).addEventListener("change", () => mode === "system" && apply());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const ORDER: ThemeMode[] = ["system", "light", "dark"];

/** Theme preference (system | light | dark), persisted; `dark` is the resolved value. */
export function useTheme() {
  const m = useSyncExternalStore(subscribe, () => mode);
  const dark = useSyncExternalStore(subscribe, () => resolved(mode) === "dark");
  useEffect(apply, []);
  const set = (next: ThemeMode) => {
    mode = next;
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
    apply();
  };
  return { mode: m, dark, set, cycle: () => set(ORDER[(ORDER.indexOf(m) + 1) % ORDER.length]) };
}

export function useDark(): boolean {
  return useTheme().dark;
}
