import { Check, ChevronDown, CircleAlert, CircleX, LoaderCircle, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { useBackendStatus } from "../backend";
import type { ServiceStatus } from "../backend/types";
import { href, navigate } from "../lib/router";
import { useTheme } from "../lib/theme";
import { Chip, IconButton, Logo } from "./ui";

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
      <span className="wordmark">leegen</span>
    </a>
  );
}

export function ThemeToggle() {
  const { mode, cycle } = useTheme();
  const icon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;
  return <IconButton icon={icon} label={`Theme: ${mode} (click to change)`} onClick={cycle} />;
}

export function RepositoryLink() {
  return (
    <a className="icon-btn" href="https://github.com/knarfthekant/leegen" target="_blank" rel="noopener noreferrer"
      aria-label="leegen on GitHub" title="leegen on GitHub">
      <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
    </a>
  );
}

export function ConnectionDot() {
  const { services } = useBackendStatus();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDetailsElement>(null);
  const panelId = useId();
  const primary = services[0];
  const online = services.filter((s) => s.state === "online").length;
  const issues = services.filter((s) => s !== primary && s.state !== "online");

  useEffect(() => {
    const closeOutside = (e: PointerEvent) => {
      if (panel.current && !root.current?.contains(e.target as Node)) panel.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  if (!primary) return null;
  return (
    <div className="service-status" ref={root} onKeyDown={(e) => {
      if (e.key === "Escape" && panel.current?.open) {
        panel.current.open = false;
        panel.current.querySelector("summary")?.focus();
        e.stopPropagation();
      }
    }} onBlur={(e) => {
      if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget) && panel.current) panel.current.open = false;
    }}>
      <details className="service-disclosure" ref={panel}>
        <summary className={`chip service-trigger tone-${serviceTone(primary.state)}`}
          aria-label="Service status" aria-controls={panelId} title="Show service status"
          aria-description={`${primary.label} ${stateLabel(primary.state).toLowerCase()}. ${online} of ${services.length} services online.`}>
          <ServiceSymbol state={primary.state} />
          <span>{primary.label} {stateLabel(primary.state).toLowerCase()}</span>
          <span className="service-count">{online}/{services.length}</span>
          <ChevronDown size={13} className="service-chevron" aria-hidden />
        </summary>
        <div className="service-panel" id={panelId} role="group" aria-label="Service details">
          <div className="service-panel-head">
            <strong>Service status</strong>
            <span>{online} of {services.length} online</span>
          </div>
          <ul className="service-list">
            {services.map((service) => (
              <li key={service.id} className="service-item">
                <div className="row between">
                  <strong>{service.label}</strong>
                  <Chip tone={serviceTone(service.state)}>
                    <ServiceSymbol state={service.state} />{stateLabel(service.state)}
                  </Chip>
                </div>
                <p>{service.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      </details>
      <div className="service-issues" aria-live="polite" aria-atomic="true">
        {issues.map((service) => (
          <Chip key={service.id} tone={serviceTone(service.state)} title={service.detail} onClick={() => {
            if (!panel.current) return;
            panel.current.open = true;
            panel.current.querySelector("summary")?.focus();
          }}>
            <ServiceSymbol state={service.state} />{service.label} {stateLabel(service.state).toLowerCase()}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function stateLabel(state: ServiceStatus["state"]) {
  return { online: "Online", offline: "Offline", connecting: "Connecting", unavailable: "Unavailable", degraded: "Partial" }[state];
}

function serviceTone(state: ServiceStatus["state"]) {
  return state === "online" ? "pass" : state === "offline" ? "fail" : "warn";
}

function ServiceSymbol({ state }: { state: ServiceStatus["state"] }) {
  const Icon = state === "online" ? Check : state === "offline" ? CircleX : state === "connecting" ? LoaderCircle : CircleAlert;
  return <Icon size={13} strokeWidth={1.9} aria-hidden className={state === "connecting" ? "spin" : undefined} />;
}
