import type { Annotation, Proposal } from "../lib/api";
import { Markdown } from "./Markdown";

interface Props {
  annotations: Annotation[];
  proposals: Proposal[];
  onJump: (file: string, line: number) => void;
  onDismiss: (a: Annotation) => void;
  onOpenProposal: (p: Proposal) => void;
}

export function ReviewPanel({ annotations, proposals, onJump, onDismiss, onOpenProposal }: Props) {
  if (!annotations.length && !proposals.length)
    return (
      <div className="panel-body muted">
        No review comments yet. Ask your AI assistant for a hint or a code review. It can comment
        on lines here and suggest edits through the leetclaude MCP server.
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
          <div className="row between">
            <span>
              <span className="tag">suggestion</span> {p.file}
            </span>
            <button className="link small" onClick={() => onOpenProposal(p)}>
              Review diff
            </button>
          </div>
          {p.rationale && <div className="muted small">{p.rationale}</div>}
        </div>
      ))}
      {[...general, ...inline].map((a) => (
        <div key={a.id} className={`review-item sev-${a.severity}`}>
          <div className="row between">
            <span>
              <span className={`tag sev sev-${a.severity}`}>{a.severity}</span>{" "}
              {a.file && a.start_line != null ? (
                <button className="link" onClick={() => onJump(a.file!, a.start_line!)}>
                  {a.file}:{a.start_line}
                  {a.end_line && a.end_line !== a.start_line ? `–${a.end_line}` : ""}
                </button>
              ) : (
                <span className="muted">general</span>
              )}
              <span className="muted small"> · {a.author}</span>
            </span>
            <button className="link small" onClick={() => onDismiss(a)}>
              Dismiss
            </button>
          </div>
          <Markdown source={a.message} />
        </div>
      ))}
    </div>
  );
}
