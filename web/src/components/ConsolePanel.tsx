import { ChevronDown, Play, Square, Trash2 } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { ConsoleResult } from "../lib/api";
import { Chip, IconButton, Select } from "./ui";
import { Value } from "./Value";

/** One console run, as shown in the history list. */
export interface ConsoleEntry {
  runId: string;
  code: string;
  file: string | null;
  stdin: string;
  status: "running" | "ok" | "error" | "timeout" | "cancelled";
  phase?: string;
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
  durationMs?: number;
}

const STATUS_TONE = {
  running: "accent",
  ok: "pass",
  error: "fail",
  timeout: "warn",
  cancelled: "fail",
} as const;

export function entryFromResult(entry: ConsoleEntry, result: ConsoleResult): ConsoleEntry {
  return {
    ...entry,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    result: result.result,
    error: result.error,
    durationMs: result.duration_ms,
  };
}

export function ConsolePanel({
  entries,
  running,
  files,
  contextFile,
  onChangeContextFile,
  code,
  onChangeCode,
  stdin,
  onChangeStdin,
  canRun,
  disabledReason,
  onRun,
  onCancel,
  onClear,
}: {
  entries: ConsoleEntry[];
  running: boolean;
  files: { path: string; role: "editable" | "readonly" }[];
  contextFile: string | null;
  onChangeContextFile: (path: string | null) => void;
  code: string;
  onChangeCode: (code: string) => void;
  stdin: string;
  onChangeStdin: (stdin: string) => void;
  canRun: boolean;
  disabledReason: string | null;
  onRun: () => void;
  onCancel: () => void;
  onClear: () => void;
}) {
  const composer = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (canRun && !running) onRun();
    }
  };
  const newestFirst = [...entries].reverse();

  return (
    <div className="panel-body console">
      {disabledReason && <p className="muted small">{disabledReason}</p>}

      <div className="console-composer">
        <div className="console-actions">
          <Select
            value={contextFile ?? ""}
            onChange={(e) => onChangeContextFile(e.target.value || null)}
            title={contextFile ? "Runs inside this file's namespace" : "Standalone snippet"}
          >
            <option value="">No file context</option>
            {files.map((f) => (
              <option key={f.path} value={f.path}>{f.path}</option>
            ))}
          </Select>
          <span className="spacer" />
          {entries.length > 0 && (
            <IconButton icon={Trash2} label="Clear results" onClick={onClear} />
          )}
          {running ? (
            <IconButton icon={Square} label="Cancel" className="icon-run" onClick={onCancel} />
          ) : (
            <IconButton
              icon={Play}
              label="Run (⌘↵)"
              className="icon-run"
              onClick={onRun}
              disabled={!canRun || !code.trim()}
            />
          )}
        </div>
        <textarea
          className="console-input mono"
          value={code}
          onChange={(e) => onChangeCode(e.target.value)}
          onKeyDown={composer}
          placeholder={'print("hello")\n1 + 1'}
          rows={4}
          spellCheck={false}
        />
        <details className="console-stdin" open={!!stdin}>
          <summary>
            <ChevronDown size={13} strokeWidth={1.9} /> stdin
          </summary>
          <textarea
            className="console-input mono"
            value={stdin}
            onChange={(e) => onChangeStdin(e.target.value)}
            rows={3}
            spellCheck={false}
          />
        </details>
      </div>

      {newestFirst.length > 0 && (
        <div className="console-history">
          {newestFirst.map((entry) => (
            <article key={entry.runId} className="console-entry">
              <div className="console-entry-head">
                <Chip tone={STATUS_TONE[entry.status]}>
                  <span className="cap">{entry.status === "running" ? entry.phase ?? "running" : entry.status}</span>
                </Chip>
                {entry.durationMs != null && (
                  <span className="muted small tabular">{entry.durationMs.toFixed(0)} ms</span>
                )}
              </div>
              {entry.stdout && <Value label="Stdout" value={entry.stdout} raw />}
              {entry.stderr && <Value label="Stderr" value={entry.stderr} raw />}
              {entry.result != null && <Value label="Result" value={entry.result} raw />}
              {entry.error && <Value label="Error" value={entry.error} raw tone="fail" />}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
