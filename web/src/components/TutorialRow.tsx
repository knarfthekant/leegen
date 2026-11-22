import type { ProblemSummary, TutorialSummary } from "../lib/api";
import { href as appHref, navigate } from "../lib/router";
import { StatusIcon } from "./ProblemRow";
import { Chip, cx } from "./ui";

export const tutorialDone = (t: TutorialSummary) => t.checked > 0 && t.passed >= t.checked;
export const tutorialStatus = (t: TutorialSummary): ProblemSummary["status"] =>
  tutorialDone(t) ? "passed" : t.passed > 0 ? "attempted" : undefined;

export function filterTutorials(tutorials: TutorialSummary[], query: string): TutorialSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return tutorials;
  return tutorials.filter((t) => [t.title, t.id, t.summary, t.environment, ...t.tags].some((s) => s.toLowerCase().includes(q)));
}

export function TutorialRow({
  t,
  index,
  compact,
  current,
  onOpen,
}: {
  t: TutorialSummary;
  index: number;
  compact?: boolean;
  current?: boolean;
  onOpen?: () => void;
}) {
  const path = `/t/${t.id}`;
  return (
    <a
      href={appHref(path)}
      className={cx("problem-row tutorial-row", compact && "compact", current && "current")}
      onClick={(e) => {
        e.preventDefault();
        onOpen?.();
        navigate(path);
      }}
    >
      <StatusIcon status={tutorialStatus(t)} />
      <span className="tr-body">
        <span className="pr-title">
          <span className="pr-index">{index + 1}.</span> {t.title}
        </span>
        {!compact && t.summary && <span className="tr-summary">{t.summary}</span>}
      </span>
      {!compact && (
        <span className="pr-meta">
          {t.tags.slice(0, 2).map((x) => (
            <Chip key={x}>{x}</Chip>
          ))}
        </span>
      )}
      <span className={cx("tr-progress tabular", tutorialDone(t) ? "tone-text-pass" : "muted")}>
        {t.checked > 0 ? `${Math.min(t.passed, t.checked)}/${t.checked}` : `${t.cells} cells`}
      </span>
    </a>
  );
}
