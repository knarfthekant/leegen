// What an agent leaves on a tutorial cell: review comments under it, and a suggested edit as a
// diff the learner accepts or rejects. The same records and look as the problem editor's
// Review panel, scoped to one cell.

import { DiffEditor } from "@monaco-editor/react";
import { Check, Sparkles, X } from "lucide-react";
import { useEffect } from "react";
import type { Annotation, Proposal } from "../lib/api";
import { monaco } from "../lib/monaco";
import { Markdown } from "./Markdown";
import { SEVERITY_ICON } from "./ReviewPanel";
import { Button, cx, IconButton } from "./ui";

const FONT = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

/** `3` · `3–5` · `3:9–14`: where in the cell a comment points. */
function where(a: Annotation): string | null {
  if (a.start_line == null) return null;
  const end = a.end_line ?? a.start_line;
  if (a.start_col != null && a.end_col != null && end === a.start_line) return `line ${a.start_line}:${a.start_col}–${a.end_col}`;
  return end !== a.start_line ? `lines ${a.start_line}–${end}` : `line ${a.start_line}`;
}

export function CellNotes({
  annotations,
  selectedId,
  onSelect,
  onDismiss,
}: {
  annotations: Annotation[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onDismiss: (a: Annotation) => void;
}) {
  if (!annotations.length) return null;
  return (
    <div className="t-notes review">
      {annotations.map((a) => {
        const Icon = SEVERITY_ICON[a.severity];
        const loc = where(a);
        return (
          <div
            key={a.id}
            className={cx("review-item", onSelect && a.start_line != null && "clickable", a.id === selectedId && "selected")}
            onClick={() => onSelect?.(a.id === selectedId ? null : a.id)}
          >
            <span className={`sev-icon sev-${a.severity}`} title={a.severity}>
              <Icon size={14} strokeWidth={1.9} />
            </span>
            <div className="review-main">
              <div className="review-head">
                <span className={`sev-label sev-${a.severity}`}>{a.severity}</span>
                {loc && <span className="loc">{loc}</span>}
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

const diffUri = (tutorialId: string, proposalId: string, side: "original" | "modified", path: string) =>
  `inmemory://tutorial/${tutorialId}/diff-${proposalId}-${side}/${path}`;

export function CellProposal({
  tutorialId,
  original,
  proposal,
  dark,
  onResolve,
}: {
  tutorialId: string;
  original: string;
  proposal: Proposal;
  dark: boolean;
  onResolve: (action: "accept" | "reject") => void;
}) {
  // The DiffEditor keeps its models alive while unmounting (disposing them first throws inside
  // Monaco); release them once the proposal is gone.
  useEffect(() => {
    const { id, file } = proposal;
    return () => {
      setTimeout(() => {
        for (const side of ["original", "modified"] as const)
          monaco.editor.getModel(monaco.Uri.parse(diffUri(tutorialId, id, side, file)))?.dispose();
      }, 0);
    };
  }, [tutorialId, proposal.id, proposal.file]);

  const lines = Math.max(original.split("\n").length, proposal.content.split("\n").length);
  return (
    <div className="t-proposal">
      <div className="proposal-bar">
        <Sparkles size={16} strokeWidth={1.8} className="accent-icon" />
        <div className="proposal-text">
          <strong>Suggested change</strong>
          <span className="muted"> by {proposal.author}</span>
          {proposal.rationale && <div className="muted small">{proposal.rationale}</div>}
        </div>
        <Button variant="ghost" icon={X} onClick={() => onResolve("reject")}>Reject</Button>
        <Button variant="primary" icon={Check} onClick={() => onResolve("accept")}>Accept</Button>
      </div>
      <div style={{ height: Math.min(Math.max(lines * 20 + 20, 70), 360) }}>
        <DiffEditor
          key={proposal.id}
          original={original}
          modified={proposal.content}
          language="python"
          theme={dark ? "lc-dark" : "lc-light"}
          originalModelPath={diffUri(tutorialId, proposal.id, "original", proposal.file)}
          modifiedModelPath={diffUri(tutorialId, proposal.id, "modified", proposal.file)}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          options={{
            readOnly: true, renderSideBySide: false, minimap: { enabled: false }, fontSize: 13, lineHeight: 20,
            fontFamily: FONT, scrollBeyondLastLine: false, padding: { top: 8, bottom: 8 }, lineNumbers: "off",
            glyphMargin: false, folding: false, overviewRulerLanes: 0, renderOverviewRuler: false, automaticLayout: true,
            scrollbar: { vertical: "hidden", alwaysConsumeMouseWheel: false },
          }}
        />
      </div>
    </div>
  );
}
