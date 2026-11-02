import { useEffect, useState } from "react";

// Paths inside the app are written without the deploy base ("/p/merge-ranges"); the base comes
// from Vite's `base` (BASE_URL), so the browser edition can be hosted under any path.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Full URL path for an app path, for `href` attributes. */
export function href(path: string): string {
  return BASE + path;
}

function appPath(): string {
  const p = location.pathname;
  return (BASE && p.startsWith(BASE) ? p.slice(BASE.length) : p) || "/";
}

export function navigate(path: string) {
  if (appPath() !== path) {
    history.pushState(null, "", href(path));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

export function usePath(): string {
  const [path, setPath] = useState(appPath);
  useEffect(() => {
    const on = () => setPath(appPath());
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}
