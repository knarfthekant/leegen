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
  /** focus an annotation (clicked in the editor), or null to unfocus */
  onSelectAnnotation: (id: string | null) => void;
  dark: boolean;
  saveState: SaveState;
  cursor: CursorInfo | null;
  maximized: boolean;
  onToggleMaximize: () => void;
}

const EDITOR_FONT = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

type Ed = monaco.editor.IStandaloneCodeEditor;

// --- annotations -------------------------------------------------------------------------------
// Each editor publishes its annotations here, keyed by model URI, so the hover provider (one for
// all models) and the click handler can find them. `range` reads the *tracked* decoration range,
// so it follows the user's edits instead of the position the annotation was created at.

interface Entry {
  a: Annotation;
  range: () => monaco.Range;
  lane: monaco.editor.GlyphMarginLane;
}

const entriesByModel = new Map<string, Entry[]>();

/**
 * The exact characters an annotation covers. The server always sends columns; annotations saved
 * before that (or created without them) fall back to the text of the line(s) minus indentation.
 */
function resolveRange(a: Annotation, model: monaco.editor.ITextModel): monaco.Range {
  const last = model.getLineCount();
  const startLine = Math.min(Math.max(a.start_line ?? 1, 1), last);
  const endLine = Math.min(Math.max(a.end_line ?? startLine, startLine), last);
  const startCol = a.start_col ?? (model.getLineFirstNonWhitespaceColumn(startLine) || model.getLineMaxColumn(startLine));
  let endCol = a.end_col ?? (model.getLineLastNonWhitespaceColumn(endLine) || startCol);
  if (startLine === endLine) endCol = Math.max(endCol, startCol);
  return new monaco.Range(startLine, startCol, endLine, endCol);
}

/** Smaller ranges first, so the most specific comment comes first at a click or hover. */
function weight(r: monaco.Range) {
  return (r.endLineNumber - r.startLineNumber) * 10000 + (r.endColumn - r.startColumn);
}

function entriesAt(uri: string, pos: monaco.IPosition): Entry[] {
  return (entriesByModel.get(uri) ?? [])
    .filter((e) => e.range().containsPosition(pos))
    .sort((x, y) => weight(x.range()) - weight(y.range()));
}

/** Each comment owns one gutter lane at its lines; comments that overlap in lines take other lanes. */
function assignLanes(items: { startLine: number; endLine: number }[]): monaco.editor.GlyphMarginLane[] {
  const lanes = [
    monaco.editor.GlyphMarginLane.Left,
    monaco.editor.GlyphMarginLane.Center,
    monaco.editor.GlyphMarginLane.Right,
  ];
  const taken: [number, number][][] = lanes.map(() => []);
  const order = items.map((_, i) => i).sort((x, y) => items[x].startLine - items[y].startLine || x - y);
  const out = new Array<monaco.editor.GlyphMarginLane>(items.length);
  for (const i of order) {
    const { startLine, endLine } = items[i];
    let lane = taken.findIndex((spans) => spans.every(([s, e]) => endLine < s || startLine > e));
    if (lane < 0) lane = lanes.length - 1; // more than three at once: the last lane is shared
    taken[lane].push([startLine, endLine]);
    out[i] = lanes[lane];
  }
  return out;
}

let hoverRegistered = false;
function registerAnnotationHover() {
  if (hoverRegistered) return;
  hoverRegistered = true;
  monaco.languages.registerHoverProvider("*", {
    provideHover(model, position) {
      const hits = entriesAt(model.uri.toString(), position);
      if (!hits.length) return null;
      return {
        range: hits[0].range(),
        contents: hits.flatMap(({ a }) => [
          { value: `**${a.severity}** · ${a.author}\n\n${a.message}` },
          { value: "_Click to focus in Review_" },
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
      if (!model || !e.event.leftButton) return;
      const { selectedAnnotationId: picked, onSelectAnnotation } = handlers.current;
      const type = e.target.type;
      const inGutter = type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
      const inText = type === monaco.editor.MouseTargetType.CONTENT_TEXT;
      const inEmpty = type === monaco.editor.MouseTargetType.CONTENT_EMPTY;
      if (!inGutter && !inText && !inEmpty) return;
      const uri = model.uri.toString();
      let hits: Entry[] = [];
      if (e.target.position) {
        if (inGutter) {
          // a dot or bar covers its comment's lines in its own lane
          const line = e.target.position.lineNumber;
          const lane = (e.target.detail as monaco.editor.IMouseTargetMarginData | undefined)?.glyphMarginLane;
          hits = (entriesByModel.get(uri) ?? []).filter((x) => {
            const r = x.range();
            return line >= r.startLineNumber && line <= r.endLineNumber && (lane == null || x.lane === lane);
          });
        } else if (inText) {
          hits = entriesAt(uri, e.target.position);
        }
      }
      if (!hits.length) {
        // a click on code that carries no comment lets go of the focused one
        if (picked) onSelectAnnotation(null);
        return;
      }
      // Clicking again steps through the comments stacked there; past the last one it unfocuses.
      const at = hits.findIndex((x) => x.a.id === picked);
      onSelectAnnotation(at < 0 ? hits[0].a.id : at + 1 < hits.length ? hits[at + 1].a.id : null);
    });
    editor.onKeyDown((e) => {
      if (e.keyCode === monaco.KeyCode.Escape && handlers.current.selectedAnnotationId)
        handlers.current.onSelectAnnotation(null);
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
    if (!coll || !model || !file) return;
    const uri = model.uri.toString();
    const mine = annotations.filter((a) => a.file === file.path && a.start_line != null);
    const ranges = mine.map((a) => resolveRange(a, model));
    const lanes = assignLanes(ranges.map((r) => ({ startLine: r.startLineNumber, endLine: r.endLineNumber })));

    // Per comment: one translucent highlight layer (layers blend, so overlaps stay visible), then
    // one gutter mark per line: a dot for a single line, a connected bar for several.
    const items: monaco.editor.IModelDeltaDecoration[] = [];
    const slots: { entry: number; kind: "text" | "glyph" }[] = [];
    mine.forEach((a, i) => {
      const r = ranges[i];
      const sel = a.id === props.selectedAnnotationId ? " lc-sel" : "";
      const sev = `lc-sev-${a.severity}`;
      items.push({
        range: r,
        options: {
          className: `lc-ann ${sev}${sel}`,
          overviewRuler: { color: severityColor(a.severity), position: monaco.editor.OverviewRulerLane.Right },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
      slots.push({ entry: i, kind: "text" });
      for (let line = r.startLineNumber; line <= r.endLineNumber; line++) {
        const part = r.startLineNumber === r.endLineNumber ? "dot" : line === r.startLineNumber ? "start" : line === r.endLineNumber ? "end" : "mid";
        items.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            glyphMargin: { position: lanes[i] },
            glyphMarginClassName: `lc-glyph lc-glyph-${part} ${sev}${sel}`,
            glyphMarginHoverMessage: { value: a.message },
          },
        });
        slots.push({ entry: i, kind: "glyph" });
      }
    });
    coll.set(items);
    const textIndex = new Map<number, number>();
    slots.forEach((s, k) => s.kind === "text" && textIndex.set(s.entry, k));
    entriesByModel.set(
      uri,
      mine.map((a, i) => ({
        a,
        lane: lanes[i],
        // the text layer's tracked range, which moves with the user's edits
        range: () => (coll.getRange(textIndex.get(i)!) ?? ranges[i]),
      })),
    );
  }

  useEffect(applyDecorations, [annotations, file?.path, props.selectedAnnotationId]);
  useEffect(
    () => () => {
      const uri = editorRef.current?.getModel()?.uri.toString();
      if (uri) entriesByModel.delete(uri);
    },
    [file?.path],
  );

  useEffect(() => {
    const r = props.revealLine;
    const ed = editorRef.current;
    if (!r || !ed || r.path !== file?.path) return;
    // Move to the start of the comment without selecting it: a selection would paint over the
    // comment's own colour, and the focus is shown by that colour darkening.
    const col = r.col ?? 1;
    ed.revealRangeInCenter(new monaco.Range(r.line, col, r.endLine ?? r.line, r.endCol ?? col));
    ed.setPosition({ lineNumber: r.line, column: col });
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
