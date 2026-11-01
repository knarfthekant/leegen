import { DiffEditor, Editor as MonacoEditor, type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import type { Annotation, Proposal } from "../lib/api";
import { languageFor, monaco } from "../lib/monaco";

export interface EditorFile {
  path: string;
  role: "editable" | "readonly";
  content: string;
  language: string | null;
}

export interface CursorInfo {
  line: number;
  column: number;
  selection: { start_line: number; end_line: number; text: string } | null;
}

interface Props {
  problemId: string;
  files: EditorFile[];
  active: string;
  onSelect: (path: string) => void;
  onChange: (path: string, value: string) => void;
  annotations: Annotation[];
  proposal: Proposal | null;
  onResolveProposal: (p: Proposal, action: "accept" | "reject") => void;
  onRun: () => void;
  onCursor: (info: CursorInfo) => void;
  onReset: () => void;
  revealLine: { path: string; line: number; nonce: number } | null;
  dark: boolean;
}

type Ed = monaco.editor.IStandaloneCodeEditor;

export function Editor(props: Props) {
  const { files, active, annotations, proposal, dark, problemId } = props;
  const editorRef = useRef<Ed | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const handlers = useRef(props);
  handlers.current = props;

  const file = files.find((f) => f.path === active) ?? files[0];

  // The DiffEditor keeps its models alive while unmounting (disposing them first throws inside
  // Monaco); release them once the proposal is gone.
  const shownProposal = proposal && file && proposal.file === file.path ? proposal : null;
  useEffect(() => {
    if (!shownProposal || !file) return;
    const id = shownProposal.id;
    const path = file.path;
    return () => {
      setTimeout(() => {
        for (const side of ["original", "modified"] as const)
          monaco.editor.getModel(monaco.Uri.parse(diffUri(problemId, id, side, path)))?.dispose();
      }, 0);
    };
  }, [shownProposal?.id, file?.path, problemId]);
  const theme = dark ? "lc-dark" : "lc-light";

  const onMount: OnMount = (editor) => {
    editorRef.current = editor as unknown as Ed;
    decorations.current = editor.createDecorationsCollection();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handlers.current.onRun());
    editor.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      const model = editor.getModel();
      const empty = sel.isEmpty();
      handlers.current.onCursor({
        line: sel.positionLineNumber,
        column: sel.positionColumn,
        selection:
          empty || !model
            ? null
            : {
                start_line: sel.startLineNumber,
                end_line: sel.endLineNumber,
                text: model.getValueInRange(sel).slice(0, 4000),
              },
      });
    });
    applyDecorations();
  };

  function applyDecorations() {
    const coll = decorations.current;
    if (!coll || !file) return;
    const items = annotations
      .filter((a) => a.file === file.path && a.start_line != null)
      .map((a) => {
        const startLine = a.start_line!;
        const endLine = a.end_line ?? startLine;
        const whole = a.start_col == null || a.end_col == null;
        return {
          range: new monaco.Range(startLine, whole ? 1 : a.start_col!, endLine, whole ? 1 : a.end_col!),
          options: {
            isWholeLine: whole,
            className: `lc-ann lc-ann-${a.severity}`,
            glyphMarginClassName: `lc-glyph lc-glyph-${a.severity}`,
            hoverMessage: { value: `**${a.severity}** · ${a.author}\n\n${a.message}` },
            glyphMarginHoverMessage: { value: a.message },
            overviewRuler: { color: severityColor(a.severity), position: monaco.editor.OverviewRulerLane.Right },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };
      });
    coll.set(items);
  }

  useEffect(applyDecorations, [annotations, file?.path]);

  useEffect(() => {
    const r = props.revealLine;
    const ed = editorRef.current;
    if (!r || !ed || r.path !== file?.path) return;
    ed.revealLineInCenter(r.line);
    ed.setPosition({ lineNumber: r.line, column: 1 });
    ed.focus();
  }, [props.revealLine?.nonce, file?.path]);

  if (!file) return <div className="editor-empty">No files</div>;

  const pendingFor = (path: string) => proposal?.file === path;

  return (
    <div className="editor">
      <div className="editor-tabs">
        {files.map((f) => (
          <button
            key={f.path}
            className={"tab" + (f.path === file.path ? " active" : "")}
            onClick={() => props.onSelect(f.path)}
            title={f.role === "readonly" ? "Read-only" : undefined}
          >
            {f.path}
            {f.role === "readonly" && <span className="lock">read-only</span>}
            {pendingFor(f.path) && <span className="dot" title="Pending AI suggestion" />}
          </button>
        ))}
        <div className="spacer" />
        <button className="link small" onClick={props.onReset} title="Restore the starter code">
          Reset
        </button>
      </div>

      {proposal && proposal.file === file.path ? (
        <div className="proposal">
          <div className="proposal-bar">
            <div>
              <strong>Suggested change</strong> by {proposal.author}
              {proposal.source === "disk" && " (edited on disk)"}
              {proposal.rationale && <span className="muted"> · {proposal.rationale}</span>}
            </div>
            <div className="row">
              <button onClick={() => props.onResolveProposal(proposal, "reject")}>Reject</button>
              <button className="primary" onClick={() => props.onResolveProposal(proposal, "accept")}>
                Accept
              </button>
            </div>
          </div>
          <DiffEditor
            key={proposal.id}
            original={file.content}
            modified={proposal.content}
            language={languageFor(file.path, file.language)}
            theme={theme}
            originalModelPath={diffUri(problemId, proposal.id, "original", file.path)}
            modifiedModelPath={diffUri(problemId, proposal.id, "modified", file.path)}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            options={{
              readOnly: true,
              renderSideBySide: false,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      ) : (
        <MonacoEditor
          path={`inmemory://${problemId}/${file.path}`}
          value={file.content}
          language={languageFor(file.path, file.language)}
          theme={theme}
          onMount={onMount}
          onChange={(v) => file.role === "editable" && props.onChange(file.path, v ?? "")}
          options={{
            readOnly: file.role !== "editable",
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 20,
            glyphMargin: true,
            scrollBeyondLastLine: false,
            tabSize: 4,
            renderLineHighlight: "line",
            automaticLayout: true,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          }}
        />
      )}
    </div>
  );
}

function diffUri(problemId: string, proposalId: string, side: "original" | "modified", path: string) {
  return `inmemory://${problemId}/diff-${proposalId}-${side}/${path}`;
}

function severityColor(s: Annotation["severity"]): string {
  return { info: "#737373", hint: "#2563eb", warning: "#ca8a04", error: "#dc2626", praise: "#16a34a" }[s];
}
