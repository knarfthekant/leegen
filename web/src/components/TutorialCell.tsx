import { Editor as MonacoEditor, type OnMount } from "@monaco-editor/react";
import { Check, CircleAlert, LoaderCircle, Play, RotateCcw, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import type { CellOutcome } from "../lib/api";
import { monaco } from "../lib/monaco";
import { cx, IconButton } from "./ui";

const FONT = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

/** What the page keeps for one code cell while and after it runs. */
export interface CellState {
  running: boolean;
  runId: string | null;
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
  outcome: CellOutcome | null;
  /** The code (or an earlier cell) changed since the outcome was produced. */
  stale: boolean;
}

export const emptyCell = (outcome: CellOutcome | null = null): CellState => ({
  running: false, runId: null, stdout: "", stderr: "", result: null, error: null, outcome, stale: false,
});

/** A cell is complete once it ran cleanly and every one of its checks passed. */
export const isComplete = (s: CellState | undefined, hasChecks: boolean): boolean =>
  !!s?.outcome && !s.stale && s.outcome.status === "ok" && (!hasChecks || (s.outcome.checks.length > 0 && s.outcome.checks.every((c) => c.status === "pass")));

/** Monaco, sized to its content so a tutorial reads as one continuous page. */
function CellEditor({ uri, value, onChange, onRun, dark }: {
  uri: string; value: string; onChange: (v: string) => void; onRun: () => void; dark: boolean;
}) {
  const [height, setHeight] = useState(58);
  const run = useRef(onRun);
  run.current = onRun;
  const onMount: OnMount = (editor) => {
    const fit = () => setHeight(Math.min(Math.max(editor.getContentHeight(), 58), 520));
    editor.onDidContentSizeChange(fit);
    fit();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run.current());
  };
  return (
    <div className="t-editor" style={{ height }}>
      <MonacoEditor
        height="100%"
        path={uri}
        value={value}
        language="python"
        theme={dark ? "lc-dark" : "lc-light"}
        onMount={onMount}
        onChange={(v) => onChange(v ?? "")}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 21,
          fontFamily: FONT,
          lineNumbers: "off",
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 14,
          lineNumbersMinChars: 0,
          scrollBeyondLastLine: false,
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          automaticLayout: true,
          tabSize: 4,
          padding: { top: 12, bottom: 12 },
          cursorBlinking: "smooth",
          scrollbar: { vertical: "hidden", horizontal: "auto", alwaysConsumeMouseWheel: false, useShadows: false },
        }}
      />
    </div>
  );
}

const DOT_ICON = { pass: Check, fail: X, error: CircleAlert } as const;

export function TutorialCell({ id, uri, code, modified, state, hasChecks, dark, onChange, onRun, onCancel, onReset }: {
  id: string;
  uri: string;
  code: string;
  modified: boolean;
  state: CellState;
  hasChecks: boolean;
  dark: boolean;
  onChange: (code: string) => void;
  onRun: () => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const { outcome, running } = state;
  const complete = isComplete(state, hasChecks);
  const failing = outcome?.checks.filter((c) => c.status !== "pass") ?? [];
  const out = state.stdout || state.stderr || state.result != null || state.error;
  return (
    <div
      id={`cell-${id}`}
      className={cx("t-cell", running && "running", complete && "complete", outcome && !running && !complete && outcome.status !== "ok" && "broken", state.stale && "stale")}
    >
      {running && <span className="t-progress" />}
      <CellEditor uri={uri} value={code} onChange={onChange} onRun={onRun} dark={dark} />
      <div className="t-tools">
        {modified && !running && <IconButton icon={RotateCcw} label="Reset cell" size={14} onClick={onReset} />}
        {running ? (
          <IconButton icon={Square} label="Stop" className="t-run" size={14} onClick={onCancel} />
        ) : (
          <IconButton icon={Play} label="Run (⌘↵)" className="t-run" size={14} onClick={onRun} />
        )}
      </div>

      {(out || (outcome && outcome.checks.length > 0)) && (
        <div className="t-after">
          {out && (
            <div className="t-out">
              {state.stdout && <pre className="mono">{state.stdout}</pre>}
              {state.stderr && <pre className="mono warn">{state.stderr}</pre>}
              {state.result != null && <pre className="mono result">{state.result}</pre>}
              {state.error && <pre className="mono fail">{state.error}</pre>}
            </div>
          )}
          {outcome && outcome.checks.length > 0 && (
            <div className="t-checks" key={outcome.ran_at}>
              {outcome.checks.map((c, i) => {
                const Icon = DOT_ICON[c.status];
                return (
                  <span key={i} className={cx("t-dot", c.status)} style={{ animationDelay: `${i * 80}ms` }}
                    title={c.description + (c.message ? ` — ${c.message}` : "")}>
                    <Icon size={11} strokeWidth={3} />
                  </span>
                );
              })}
              {running && <LoaderCircle size={14} className="spin" />}
            </div>
          )}
          {failing.length > 0 && (
            <ul className="t-fails">
              {failing.map((c, i) => (
                <li key={i}>
                  {c.description}
                  {c.message && <span className="mono"> {c.message}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
