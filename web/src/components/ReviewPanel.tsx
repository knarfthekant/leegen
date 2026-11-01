import { CircleX, Info, Lightbulb, MessageSquare, Sparkles, ThumbsUp, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { Annotation, Proposal, Severity } from "../lib/api";
import { Markdown } from "./Markdown";
import { Button, IconButton } from "./ui";

interface Props {
  annotations: Annotation[];
  proposals: Proposal[];
  onJump: (file: string, line: number) => void;
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

export function ReviewPanel({ annotations, proposals, onJump, onDismiss, onOpenProposal }: Props) {
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
    <div className="panel-body review">
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
          <div key={a.id} className="review-item">
            <span className={`sev-icon sev-${a.severity}`} title={a.severity}>
              <Icon size={14} strokeWidth={1.9} />
            </span>
            <div className="review-main">
              <div className="review-head">
                <span className={`sev-label sev-${a.severity}`}>{a.severity}</span>
                {a.file && a.start_line != null ? (
                  <button className="loc" onClick={() => onJump(a.file!, a.start_line!)}>
                    {a.file}:{a.start_line}
                    {a.end_line && a.end_line !== a.start_line ? `–${a.end_line}` : ""}
                  </button>
                ) : (
                  <span className="muted small">general</span>
                )}
                <span className="muted small">· {a.author}</span>
              </div>
              <Markdown source={a.message} />
            </div>
            <IconButton icon={X} label="Dismiss" className="dismiss" size={14} onClick={() => onDismiss(a)} />
          </div>
        );
      })}
    </div>
  );
}
