import { Box, CircleCheck, CircleDashed, Cpu, Zap } from "lucide-react";
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
        </span>
      )}
      {compact && (hw.length > 0 ? <Zap size={13} className="pr-hw" aria-label={hw.join(", ")} /> : <span />)}
      <span className={cx("pr-diff", `tone-text-${DIFFICULTY_TONE[p.difficulty]}`)}>{p.difficulty}</span>
    </a>
  );
}
