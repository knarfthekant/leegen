import { CircleX, Info, Lightbulb, MessageSquare, Sparkles, ThumbsUp, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Annotation, Proposal, Severity } from "../lib/api";
import { Markdown } from "./Markdown";
import { Button, cx, IconButton } from "./ui";

interface Props {
  annotations: Annotation[];
  proposals: Proposal[];
  /** the highlighted annotation, if any (clicked in the editor or in this list) */
  selectedId: string | null;
  /** focus an annotation and move the editor to it; null unfocuses */
  onSelect: (a: Annotation | null) => void;
  onDismiss: (a: Annotation) => void;
  onOpenProposal: (p: Proposal) => void;
}

const SEVERITY_ICON: Record<Severity, LucideIcon> = {
  info: Info,
  hint: Lightbulb,
  warning: TriangleAlert,
  error: CircleX,
  praise: ThumbsUp,
};

/** `solution.py:3` · `solution.py:3–5` · `solution.py:3:9–3:14` (exact characters) */
export function locLabel(a: Annotation): string {
  const end = a.end_line ?? a.start_line!;
  if (a.start_col != null && a.end_col != null)
    return `${a.file}:${a.start_line}:${a.start_col}–${end === a.start_line ? "" : `${end}:`}${a.end_col}`;
  return `${a.file}:${a.start_line}${end !== a.start_line ? `–${end}` : ""}`;
}

export function ReviewPanel({ annotations, proposals, selectedId, onSelect, onDismiss, onOpenProposal }: Props) {
  const selectedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  if (!annotations.length && !proposals.length)
    return (
      <div className="empty">
        <MessageSquare size={20} strokeWidth={1.6} />
        <span>
          No review comments yet. Ask your AI assistant for a hint or a code review. It can comment on lines here and
          suggest edits through the leetclaude MCP server.
        </span>
      </div>
    );
  const general = annotations.filter((a) => !a.file || a.start_line == null);
  const inline = annotations
    .filter((a) => a.file && a.start_line != null)
    .sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : a.start_line! - b.start_line!));

  return (
    <div
      className="panel-body review"
      // a click on the empty space around the comments lets go of the focused one
      onClick={(e) => e.target === e.currentTarget && selectedId && onSelect(null)}
    >
      {proposals.map((p) => (
        <div key={p.id} className="review-item">
          <span className="sev-icon sev-hint">
            <Sparkles size={14} strokeWidth={1.9} />
          </span>
          <div className="review-main">
            <div className="review-head">
              <strong>Suggested edit</strong>
              <code className="loc">{p.file}</code>
              <span className="muted small">· {p.author}</span>
            </div>
            {p.rationale && <div className="muted small">{p.rationale}</div>}
          </div>
          <Button variant="soft" onClick={() => onOpenProposal(p)}>
            Review diff
          </Button>
        </div>
      ))}
      {[...general, ...inline].map((a) => {
        const Icon = SEVERITY_ICON[a.severity];
        return (
          <div
            key={a.id}
            ref={a.id === selectedId ? selectedRef : undefined}
            className={cx("review-item", a.file && a.start_line != null && "clickable", a.id === selectedId && "selected")}
            onClick={() => onSelect(a.id === selectedId ? null : a)}
          >
            <span className={`sev-icon sev-${a.severity}`} title={a.severity}>
              <Icon size={14} strokeWidth={1.9} />
            </span>
            <div className="review-main">
              <div className="review-head">
                <span className={`sev-label sev-${a.severity}`}>{a.severity}</span>
                {a.file && a.start_line != null ? (
                  <span className="loc">{locLabel(a)}</span>
                ) : (
                  <span className="muted small">general</span>
                )}
                <span className="muted small">· {a.author}</span>
              </div>
              <Markdown source={a.message} />
            </div>
            <IconButton icon={X} label="Dismiss" className="dismiss" size={14} onClick={(e) => { e.stopPropagation(); onDismiss(a); }} />
          </div>
        );
      })}
    </div>
  );
}
