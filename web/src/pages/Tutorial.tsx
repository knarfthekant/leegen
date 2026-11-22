import { CircleAlert, ChevronLeft, ListVideo } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brand, ConnectionDot, ThemeToggle } from "../components/Chrome";
import { Markdown } from "../components/Markdown";
import { emptyCell, isComplete, TutorialCell, type CellState } from "../components/TutorialCell";
import { cx, IconButton, Skeleton } from "../components/ui";
import { getBackend, useBackendEvents } from "../backend";
import { newRunId, type CellOutcome, type Tutorial } from "../lib/api";
import { navigate } from "../lib/router";
import { useDark } from "../lib/theme";

type CodeCell = Extract<Tutorial["cells"][number], { type: "code" }>;

export function TutorialPage({ id }: { id: string }) {
  const api = getBackend().tutorials;
  const dark = useDark();
  const [tutorial, setTutorial] = useState<Tutorial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [cells, setCells] = useState<Record<string, CellState>>({});
  const saved = useRef<Record<string, string>>({});
  const loaded = useRef(false);
  const stopAll = useRef(false);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!api) {
      setError("Tutorials are not available in this edition yet.");
      return;
    }
    api.get(id).then(
      (t) => {
        if (!alive) return;
        setTutorial(t);
        setFiles(t.files);
        saved.current = { ...t.files };
        setCells(Object.fromEntries(Object.entries(t.results).map(([k, v]) => [k, emptyCell(v)])));
        loaded.current = true;
      },
      (e) => alive && setError(String(e.message ?? e)),
    );
    return () => { alive = false; };
  }, [api, id]);

  // Save the learner's code shortly after they stop typing.
  useEffect(() => {
    if (!api || !loaded.current) return;
    const t = setTimeout(() => {
      const changed = Object.fromEntries(Object.entries(files).filter(([k, v]) => saved.current[k] !== v));
      if (!Object.keys(changed).length) return;
      api.saveFiles(id, changed).then(() => Object.assign(saved.current, changed), () => undefined);
    }, 500);
    return () => clearTimeout(t);
  }, [api, id, files]);

  // Output streams in while a cell runs.
  useBackendEvents((e) => {
    if (e.type !== "console_output") return;
    setCells((cs) => {
      const hit = Object.entries(cs).find(([, c]) => c.runId === e.run_id);
      if (!hit) return cs;
      const [key, c] = hit;
      return { ...cs, [key]: e.stream === "stderr" ? { ...c, stderr: c.stderr + e.text } : { ...c, stdout: c.stdout + e.text } };
    });
  });

  const code: CodeCell[] = useMemo(
    () => (tutorial?.cells.filter((c): c is CodeCell => c.type === "code") ?? []),
    [tutorial],
  );
  const patch = useCallback((cid: string, p: Partial<CellState>) =>
    setCells((cs) => ({ ...cs, [cid]: { ...(cs[cid] ?? emptyCell()), ...p } })), []);

  const edit = (cell: CodeCell, value: string) => {
    setFiles((f) => ({ ...f, [cell.path]: value }));
    // This cell and every later one now rest on different code.
    const from = code.findIndex((c) => c.id === cell.id);
    setCells((cs) => {
      const next = { ...cs };
      for (const c of code.slice(from)) if (next[c.id]?.outcome) next[c.id] = { ...next[c.id], stale: true };
      return next;
    });
  };

  const run = useCallback(async (cell: CodeCell, current: Record<string, string>): Promise<boolean> => {
    if (!api) return false;
    const rid = newRunId();
    setCells((cs) => ({ ...cs, [cell.id]: { ...emptyCell(), running: true, runId: rid, outcome: cs[cell.id]?.outcome ?? null, stale: true } }));
    try {
      const r = await api.runCell(id, cell.id, current, rid);
      Object.assign(saved.current, current);
      const outcome: CellOutcome = {
        status: r.status, checks: r.checks ?? [], ran_at: Date.now(),
        passed: r.status === "ok" && (r.checks ?? []).length > 0 && (r.checks ?? []).every((c) => c.status === "pass"),
      };
      setCells((cs) => ({
        ...cs,
        [cell.id]: { ...cs[cell.id], running: false, runId: null, outcome, stale: false,
          stdout: r.stdout, stderr: r.stderr, result: r.result, error: r.error },
      }));
      return r.status === "ok" && outcome.checks.every((c) => c.status === "pass");
    } catch (e) {
      patch(cell.id, { running: false, runId: null, error: String((e as Error).message ?? e) });
      return false;
    }
  }, [api, id, patch]);

  const runAll = async () => {
    setAll(true);
    stopAll.current = false;
    for (const c of code) {
      if (stopAll.current || !(await run(c, files))) break;
    }
    setAll(false);
  };

  const reset = async (cell: CodeCell) => {
    if (!api) return;
    const r = await api.reset(id, cell.id);
    saved.current = { ...r.files };
    setFiles(r.files);
    setCells((cs) => ({ ...cs, [cell.id]: emptyCell() }));
  };

  if (error)
    return (
      <div className="list-page">
        <header className="topbar"><Brand /></header>
        <main className="list-main">
          <div className="soft-alert tone-fail">
            <CircleAlert size={16} strokeWidth={1.9} />
            <div className="soft-alert-body"><strong>Could not open “{id}”</strong><pre>{error}</pre></div>
          </div>
        </main>
      </div>
    );

  const done = (c: CodeCell) => isComplete(cells[c.id], c.has_checks);
  const anyRunning = Object.values(cells).some((c) => c.running);

  return (
    <div className="list-page">
      <header className="topbar">
        <div className="topbar-side">
          <Brand />
          <span className="topbar-divider" />
          <IconButton icon={ChevronLeft} label="All tutorials" onClick={() => navigate("/?view=tutorials")} />
        </div>
        <Trail cells={code} done={done} running={(c) => !!cells[c.id]?.running} />
        <div className="topbar-side end">
          <IconButton icon={ListVideo} label="Run all" onClick={runAll} disabled={anyRunning || all || !tutorial} />
          <ConnectionDot />
          <ThemeToggle />
        </div>
      </header>
      <main className="list-main">
        {!tutorial ? (
          <div className="t-doc"><Skeleton w="50%" h={28} /><Skeleton /><Skeleton w="85%" /><Skeleton h={90} r={12} /></div>
        ) : (
          <article className="t-doc">
            <h1 className="page-title">{tutorial.title}</h1>
            {tutorial.cells.map((c, i) => {
              if (c.type === "markdown") {
                const next = tutorial.cells.slice(i + 1).find((x): x is CodeCell => x.type === "code");
                return (
                  <section key={i} className={cx("t-item md", next && done(next) && "done")}>
                    <Markdown source={c.text} />
                  </section>
                );
              }
              const state = cells[c.id] ?? emptyCell();
              return (
                <section key={c.id} className={cx("t-item code", done(c) && "done", state.running && "running")}>
                  <span className={cx("t-node", done(c) && "complete", state.running && "running")} />
                  <TutorialCell
                    id={c.id}
                    uri={`inmemory://tutorial/${tutorial.id}/${c.path}`}
                    code={files[c.path] ?? c.starter}
                    modified={(files[c.path] ?? c.starter) !== c.starter}
                    state={state}
                    hasChecks={c.has_checks}
                    dark={dark}
                    onChange={(v) => edit(c, v)}
                    onRun={() => void run(c, files)}
                    onCancel={() => state.runId && api?.cancel(state.runId)}
                    onReset={() => void reset(c)}
                  />
                </section>
              );
            })}
          </article>
        )}
      </main>
    </div>
  );
}

/** Progress as a graphic: one node per code cell on a line that fills as cells complete. */
function Trail({ cells, done, running }: { cells: CodeCell[]; done: (c: CodeCell) => boolean; running: (c: CodeCell) => boolean }) {
  if (!cells.length) return <div className="spacer" />;
  const firstOpen = cells.findIndex((c) => !done(c));
  return (
    <nav className="t-trail" aria-label="Progress">
      {cells.map((c, i) => (
        <span key={c.id} className="t-trail-step">
          {i > 0 && <span className={cx("t-trail-line", done(cells[i - 1]) && "done")} />}
          <button
            type="button"
            className={cx("t-trail-node", done(c) && "done", i === firstOpen && "next", running(c) && "running")}
            aria-label={`Cell ${i + 1}`}
            onClick={() => document.getElementById(`cell-${c.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
          />
        </span>
      ))}
    </nav>
  );
}
