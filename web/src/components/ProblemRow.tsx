import { Box, CircleCheck, CircleDashed, Cpu, Globe, Server, Zap } from "lucide-react";
import { getBackend } from "../backend";
import type { ProblemSummary } from "../lib/api";
import { href as appHref, navigate } from "../lib/router";
import { Chip, cx, DIFFICULTY_TONE } from "./ui";

export function filterProblems(problems: ProblemSummary[], query: string): ProblemSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return problems;
  return problems.filter((p) =>
    [p.title, p.id, p.track ?? "", p.environment, ...p.tags].some((s) => s.toLowerCase().includes(q)),
  );
}

export const hardware = (p: { requires: string[] }) => p.requires.filter((r) => r !== "cpu");

/** Where a problem runs when it can't run in this edition (from its environment's runtimes). */
export function elsewhere(runtimes: string[] | undefined): { label: string; title: string; server: boolean } | null {
  if (!runtimes) return null;
  if (getBackend().edition === "browser" && !runtimes.includes("pyodide")) {
    return { label: "server edition", title: "Runs on the local/remote edition (native executors), not in the browser", server: true };
  }
  if (getBackend().edition === "server" && !runtimes.includes("native")) {
    return { label: "browser edition", title: "Runs only in the browser edition (WebGPU / Pyodide)", server: false };
  }
  return null;
}

export function ElsewhereChip({ runtimes }: { runtimes: string[] | undefined }) {
  const where = elsewhere(runtimes);
  if (!where) return null;
  return (
    <Chip icon={where.server ? Server : Globe} title={where.title}>
      {where.label}
    </Chip>
  );
}

export function StatusIcon({ status }: { status?: ProblemSummary["status"] }) {
  if (status === "passed") return <CircleCheck size={16} strokeWidth={2} className="st-passed" aria-label="Passed" />;
  if (status === "attempted") return <CircleDashed size={16} strokeWidth={2} className="st-attempted" aria-label="Attempted" />;
  return <span className="st-none" />;
}

export function ProblemRow({
  p,
  index,
  compact,
  current,
  onOpen,
}: {
  p: ProblemSummary;
  index: number;
  compact?: boolean;
  current?: boolean;
  onOpen?: () => void;
}) {
  const hw = hardware(p);
  const path = `/p/${p.id}`;
  return (
    <a
      href={appHref(path)}
      className={cx("problem-row", compact && "compact", current && "current")}
      onClick={(e) => {
        e.preventDefault();
        onOpen?.();
        navigate(path);
      }}
    >
      <StatusIcon status={p.status} />
      <span className="pr-title">
        <span className="pr-index">{index + 1}.</span> {p.title}
      </span>
      {!compact && (
        <span className="pr-meta">
          {p.track && <Chip>{p.track}</Chip>}
          <Chip icon={Box}>{p.environment}</Chip>
          {hw.map((r) => (
            <Chip key={r} icon={r === "cpu" ? Cpu : Zap}>
              {r}
            </Chip>
          ))}
          <ElsewhereChip runtimes={p.runtimes} />
        </span>
      )}
      {compact && (hw.length > 0 ? <Zap size={13} className="pr-hw" aria-label={hw.join(", ")} /> : <span />)}
      <span className={cx("pr-diff", `tone-text-${DIFFICULTY_TONE[p.difficulty]}`)}>{p.difficulty}</span>
    </a>
  );
}
