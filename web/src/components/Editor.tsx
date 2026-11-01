import { DiffEditor, Editor as MonacoEditor, type OnMount } from "@monaco-editor/react";
import { Check, CircleAlert, CloudCheck, CodeXml, LoaderCircle, Lock, Maximize2, Minimize2, Redo2, RotateCcw, Sparkles, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Annotation, Proposal } from "../lib/api";
import { languageFor, monaco } from "../lib/monaco";
import { Button, cx, IconButton } from "./ui";

export type SaveState = "saved" | "saving" | "error";

export interface EditorFile {
  path: string;
  role: "editable" | "readonly";
  content: string;
  language: string | null;
}

/** Where to move the editor. With columns (end exclusive) the exact characters get selected. */
export interface RevealTarget {
  path: string;
  line: number;
  endLine?: number;
  col?: number;
  endCol?: number;
  nonce: number;
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
  revealLine: RevealTarget | null;
  /** annotation highlighted in the editor and in the Review panel */
  selectedAnnotationId: string | null;
  /** the user clicked an annotation in the editor (gutter dot or highlighted text) */
  onSelectAnnotation: (id: string) => void;
  dark: boolean;
  saveState: SaveState;
  cursor: CursorInfo | null;
  maximized: boolean;
  onToggleMaximize: () => void;
}

const EDITOR_FONT = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

type Ed = monaco.editor.IStandaloneCodeEditor;

// --- annotation hover peek -------------------------------------------------------------------
// One provider for every model. Each editor publishes its annotations here, keyed by model URI,
// so overlapping ranges all show up in a single peek.

const annotationsByModel = new Map<string, Annotation[]>();

function annotationRange(a: Annotation): monaco.Range {
  const startLine = a.start_line ?? 1;
  const endLine = a.end_line ?? startLine;
  return a.start_col == null || a.end_col == null
    ? new monaco.Range(startLine, 1, endLine, Number.MAX_SAFE_INTEGER)
    : new monaco.Range(startLine, a.start_col, endLine, a.end_col);
}

const isPrecise = (a: Annotation) => a.start_col != null && a.end_col != null;

/** Annotations covering a position, smallest range first (the most specific one wins a click). */
function annotationsAt(uri: string, pos: monaco.IPosition): Annotation[] {
  return (annotationsByModel.get(uri) ?? [])
    .filter((a) => annotationRange(a).containsPosition(pos))
    .sort((a, b) => size(a) - size(b));
}

function size(a: Annotation) {
  const startLine = a.start_line ?? 1;
  const endLine = a.end_line ?? startLine;
  return isPrecise(a) && startLine === endLine ? a.end_col! - a.start_col! : (endLine - startLine + 1) * 1000;
}

let hoverRegistered = false;
function registerAnnotationHover() {
  if (hoverRegistered) return;
  hoverRegistered = true;
  monaco.languages.registerHoverProvider("*", {
    provideHover(model, position) {
      const hits = annotationsAt(model.uri.toString(), position);
      if (!hits.length) return null;
      return {
        range: annotationRange(hits[0]).intersectRanges(model.getFullModelRange()) ?? undefined,
        contents: hits.flatMap((a) => [
          { value: `**${a.severity}** · ${a.author}\n\n${a.message}` },
          { value: `_${isPrecise(a) ? "Click" : "Click the dot in the gutter"} to open in Review_` },
        ]),
      };
    },
  });
}

export function Editor(props: Props) {
  const { files, active, annotations, proposal, dark, problemId } = props;
  const editorRef = useRef<Ed | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const handlers = useRef(props);
  handlers.current = props;
  const [undoState, setUndoState] = useState({ undo: false, redo: false });

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
    registerAnnotationHover();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handlers.current.onRun());
    const syncUndo = () => {
      const model = editor.getModel();
      setUndoState({ undo: !!model?.canUndo(), redo: !!model?.canRedo() });
    };
    editor.onDidChangeModelContent(syncUndo);
    syncUndo();
    editor.onMouseDown((e) => {
      const model = editor.getModel();
      if (!model || !e.target.position || !e.event.leftButton) return;
      const inGutter = e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
      const onText = e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT;
      if (!inGutter && !onText) return;
      // Text clicks only count on exact-range highlights, so editing a whole-line one never
      // yanks the user into the Review tab. The gutter dot selects any annotation.
      const hit = annotationsAt(model.uri.toString(), e.target.position).find((a) => inGutter || isPrecise(a));
      if (hit) handlers.current.onSelectAnnotation(hit.id);
    });
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
    const model = editorRef.current?.getModel();
    if (!coll || !file) return;
    const mine = annotations.filter((a) => a.file === file.path && a.start_line != null);
    if (model) annotationsByModel.set(model.uri.toString(), mine);
    const items = mine.map((a) => {
      const precise = isPrecise(a);
      const picked = a.id === props.selectedAnnotationId;
      return {
        range: annotationRange(a),
        options: {
          isWholeLine: !precise,
          // exact ranges: a tinted, underlined span; whole lines: a tinted band
          // `className` paints a layer behind the text (fine for line bands); exact ranges use
          // `inlineClassName` so the styled span wraps the characters themselves.
          ...(precise
            ? { inlineClassName: cx("lc-ann-text", `lc-ann-${a.severity}`, picked && "lc-ann-selected") }
            : { className: cx("lc-ann", `lc-ann-${a.severity}`, picked && "lc-ann-selected") }),
          glyphMarginClassName: `lc-glyph lc-glyph-${a.severity}${picked ? " lc-glyph-selected" : ""}`,
          glyphMarginHoverMessage: { value: a.message },
          overviewRuler: { color: severityColor(a.severity), position: monaco.editor.OverviewRulerLane.Right },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      };
    });
    coll.set(items);
  }

  useEffect(applyDecorations, [annotations, file?.path, props.selectedAnnotationId]);
  useEffect(
    () => () => {
      const uri = editorRef.current?.getModel()?.uri.toString();
      if (uri) annotationsByModel.delete(uri);
    },
    [file?.path],
  );

  useEffect(() => {
    const r = props.revealLine;
    const ed = editorRef.current;
    if (!r || !ed || r.path !== file?.path) return;
    if (r.col != null && r.endCol != null) {
      const range = new monaco.Range(r.line, r.col, r.endLine ?? r.line, r.endCol);
      ed.revealRangeInCenter(range);
      ed.setSelection(range);
    } else {
      ed.revealLineInCenter(r.line);
      ed.setPosition({ lineNumber: r.line, column: 1 });
    }
    ed.focus();
  }, [props.revealLine?.nonce, file?.path]);

  if (!file) return <div className="editor-empty">No files</div>;

  const canEdit = file.role === "editable";
  const pendingFor = (path: string) => proposal?.file === path;
  const showingProposal = proposal && proposal.file === file.path;

  return (
    <div className="editor">
      <div className="card-head">
        <span className="card-title">
          <CodeXml size={16} strokeWidth={1.9} className="accent-icon" />
          Code
        </span>
      </div>
      <div className="editor-sub">
        <div className="file-tabs" role="tablist">
          {files.map((f) => (
            <button
              key={f.path}
              role="tab"
              aria-selected={f.path === file.path}
              className={cx("file-tab", f.path === file.path && "active")}
              onClick={() => props.onSelect(f.path)}
              title={f.role === "readonly" ? `${f.path} (read-only)` : f.path}
            >
              {f.role === "readonly" && <Lock size={12} strokeWidth={2} />}
              {f.path}
              {pendingFor(f.path) && <Sparkles size={12} strokeWidth={2} className="accent-icon" aria-label="Pending AI suggestion" />}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <IconButton
            icon={Undo2}
            label="Undo (⌘Z)"
            disabled={!canEdit || !!showingProposal || !undoState.undo}
            onClick={() => editorRef.current?.trigger("toolbar", "undo", null)}
          />
          <IconButton
            icon={Redo2}
            label="Redo (⇧⌘Z)"
            disabled={!canEdit || !!showingProposal || !undoState.redo}
            onClick={() => editorRef.current?.trigger("toolbar", "redo", null)}
          />
          <IconButton icon={RotateCcw} label="Reset to starter code" onClick={props.onReset} />
          <IconButton
            icon={props.maximized ? Minimize2 : Maximize2}
            label={props.maximized ? "Restore layout" : "Maximize editor"}
            onClick={props.onToggleMaximize}
          />
        </div>
      </div>

      {showingProposal ? (
        <div className="proposal">
          <div className="proposal-bar">
            <Sparkles size={16} strokeWidth={1.8} className="accent-icon" />
            <div className="proposal-text">
              <strong>Suggested change</strong>
              <span className="muted">
                {" "}by {proposal.author}
                {proposal.source === "disk" && " (edited on disk)"}
              </span>
              {proposal.rationale && <div className="muted small">{proposal.rationale}</div>}
            </div>
            <Button variant="ghost" icon={X} onClick={() => props.onResolveProposal(proposal, "reject")}>
              Reject
            </Button>
            <Button variant="primary" icon={Check} onClick={() => props.onResolveProposal(proposal, "accept")}>
              Accept
            </Button>
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
              fontFamily: EDITOR_FONT,
              scrollBeyondLastLine: false,
              padding: { top: 8 },
            }}
          />
        </div>
      ) : (
        <MonacoEditor
          // One editor instance per file. @monaco-editor/react applies the new `value` before it
          // swaps the model for the new `path`, so a shared instance writes the next tab's content
          // into the previous file's model; for an editable file that fires onChange and saves
          // (e.g. test_visible.py's text ends up in solution.py).
          key={file.path}
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
            lineHeight: 21,
            glyphMargin: true,
            scrollBeyondLastLine: false,
            tabSize: 4,
            renderLineHighlight: "line",
            automaticLayout: true,
            fontFamily: EDITOR_FONT,
            padding: { top: 8, bottom: 8 },
            smoothScrolling: true,
            cursorSmoothCaretAnimation: "on",
            cursorBlinking: "smooth",
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: true,
          }}
        />
      )}

      <div className="statusbar">
        <span className={cx("save-state", props.saveState)}>
          {file.role === "readonly" ? (
            <>
              <Lock size={12} /> Read-only
            </>
          ) : props.saveState === "saving" ? (
            <>
              <LoaderCircle size={12} className="spin" /> Saving…
            </>
          ) : props.saveState === "error" ? (
            <>
              <CircleAlert size={12} /> Not saved
            </>
          ) : (
            <>
              <CloudCheck size={12} /> Saved
            </>
          )}
        </span>
        <span className="tabular">
          {props.cursor ? `Ln ${props.cursor.line}, Col ${props.cursor.column}` : ""}
          {props.cursor?.selection ? ` (${props.cursor.selection.end_line - props.cursor.selection.start_line + 1} lines selected)` : ""}
        </span>
      </div>
    </div>
  );
}

function diffUri(problemId: string, proposalId: string, side: "original" | "modified", path: string) {
  return `inmemory://${problemId}/diff-${proposalId}-${side}/${path}`;
}

function severityColor(s: Annotation["severity"]): string {
  return { info: "#8a8a86", hint: "#5b7fd6", warning: "#d19a2a", error: "#d9534f", praise: "#3f9a63" }[s];
}
