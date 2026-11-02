import { Monitor, Moon, Sun } from "lucide-react";
import { useBackendStatus } from "../backend";
import { href, navigate } from "../lib/router";
import { useTheme } from "../lib/theme";
import { IconButton, Logo } from "./ui";

export function Brand() {
  return (
    <a
      href={href("/")}
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
  const status = useBackendStatus();
  return (
    <span className={"live" + (status.ok ? " on" : "")} title={status.title}>
      <span className="live-dot" />
      {status.label}
    </span>
  );
}
