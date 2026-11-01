import { Monitor, Moon, Sun } from "lucide-react";
import { useConnection } from "../lib/events";
import { navigate } from "../lib/router";
import { useTheme } from "../lib/theme";
import { IconButton, Logo } from "./ui";

export function Brand() {
  return (
    <a
      href="/"
      className="brand"
      onClick={(e) => {
        e.preventDefault();
        navigate("/");
      }}
    >
      <Logo />
      <span className="wordmark">leetclaude</span>
    </a>
  );
}

export function ThemeToggle() {
  const { mode, cycle } = useTheme();
  const icon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;
  return <IconButton icon={icon} label={`Theme: ${mode} (click to change)`} onClick={cycle} />;
}

export function ConnectionDot() {
  const live = useConnection();
  return (
    <span className={"live" + (live ? " on" : "")} title={live ? "Connected to the leetclaude server" : "Reconnecting…"}>
      <span className="live-dot" />
      {live ? "Live" : "Offline"}
    </span>
  );
}
