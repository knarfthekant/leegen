import { CircleAlert, ChevronLeft, ChevronRight, List, ListVideo } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brand, ConnectionDot, ThemeToggle } from "../components/Chrome";
import { Markdown } from "../components/Markdown";
import { CellNotes } from "../components/CellReview";
import { emptyCell, isComplete, TutorialCell, type CellCursor, type CellState } from "../components/TutorialCell";
import { TutorialDrawer } from "../components/ProblemDrawer";
import { Button, cx, IconButton, Skeleton } from "../components/ui";
import { getBackend, useBackendEvents } from "../backend";
import { newRunId, type Annotation, type CellOutcome, type Proposal, type Tutorial, type TutorialSummary } from "../lib/api";
import type { ConsoleResult } from "../contracts/generated";
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
  const [list, setList] = useState<TutorialSummary[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // what an agent left on the cells, and where the learner is (reported so agents can see it)
  const shim = `tut-${id}`;
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CellCursor | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!api) {
      setError("Tutorials are not available in this edition.");
      return;
    }
    api.get(id).then(
      (t) => {
        if (!alive) return;
        setTutorial(t);
        setFiles(t.files);
        saved.current = { ...t.files };
        setCells(Object.fromEntries(Object.entries(t.results).map(([k, v]) => [k, emptyCell(v)])));
        setAnnotations(t.annotations ?? []);
        setProposals(t.proposals ?? []);
        loaded.current = true;
      },
      (e) => alive && setError(String(e.message ?? e)),
    );
    return () => { alive = false; };
  }, [api, id, reloadKey]);

  // The list behind prev/next and the drawer; reloaded on open so its progress is current.
  useEffect(() => {
    api?.list().then((r) => setList(r.tutorials), () => undefined);
  }, [api, drawerOpen]);

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

  // Tell agents where the learner is: every cell's current code, the focused cell, the selection.
  useEffect(() => {
    if (!tutorial) return;
    const t = setTimeout(() => {
      getBackend()
        .reportSession({
          problem_id: shim, buffers: files, active_file: active ?? "",
          cursor: cursor ? { line: cursor.line, column: cursor.column } : null,
          selection: cursor?.selection ?? null, executor: null,
        })
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [tutorial, shim, files, active, cursor]);

  // Output streams in while a cell runs; agents' comments, edits and runs arrive as events too.
  useBackendEvents((e) => {
    switch (e.type) {
      case "console_output":
        setCells((cs) => {
          const hit = Object.entries(cs).find(([, c]) => c.runId === e.run_id);
          if (!hit) return cs;
          const [key, c] = hit;
          return { ...cs, [key]: e.stream === "stderr" ? { ...c, stderr: c.stderr + e.text } : { ...c, stdout: c.stdout + e.text } };
        });
        break;
      case "annotations_changed":
        if (e.problem_id === shim) setAnnotations(e.annotations);
        break;
      case "proposals_changed":
        if (e.problem_id === shim) setProposals(e.proposals);
        break;
      case "files_changed":
        if (e.problem_id === shim) applyFiles(e.files);
        break;
      case "tutorial_cell_finished":
        // runs started here finish in run(); this is an agent running a cell on the learner's code
        if (e.tutorial_id === id && e.source !== "ui") finishCell(e.cell, e.result);
        break;
      case "tutorial_changed":
        if (e.tutorial_id === id) setReloadKey((k) => k + 1);
        break;
    }
  });

  const code: CodeCell[] = useMemo(
    () => (tutorial?.cells.filter((c): c is CodeCell => c.type === "code") ?? []),
    [tutorial],
  );
  const patch = useCallback((cid: string, p: Partial<CellState>) =>
    setCells((cs) => ({ ...cs, [cid]: { ...(cs[cid] ?? emptyCell()), ...p } })), []);

  /** This cell and every later one now rest on different code. */
  const markStale = (from: number) =>
    setCells((cs) => {
      const next = { ...cs };
      for (const c of code.slice(Math.max(from, 0))) if (next[c.id]?.outcome) next[c.id] = { ...next[c.id], stale: true };
      return next;
    });

  const edit = (cell: CodeCell, value: string) => {
    setFiles((f) => ({ ...f, [cell.path]: value }));
    markStale(code.findIndex((c) => c.id === cell.id));
  };

  /** Files changed from outside the editor (an accepted suggestion): already saved. */
  const applyFiles = (changed: Record<string, string>) => {
    Object.assign(saved.current, changed);
    setFiles((f) => ({ ...f, ...changed }));
    markStale(code.findIndex((c) => c.path in changed));
  };

  /** A finished run, from the Run button or an agent: its outcome, output and ticks. */
  const finishCell = (cellId: string, r: ConsoleResult): boolean => {
    const outcome: CellOutcome = {
      status: r.status, checks: r.checks ?? [], ran_at: Date.now(),
      passed: r.status === "ok" && (r.checks ?? []).length > 0 && (r.checks ?? []).every((c) => c.status === "pass"),
    };
    setCells((cs) => ({
      ...cs,
      [cellId]: { ...(cs[cellId] ?? emptyCell()), running: false, runId: null, outcome, stale: false,
        stdout: r.stdout, stderr: r.stderr, result: r.result, error: r.error },
    }));
    return r.status === "ok" && outcome.checks.every((c) => c.status === "pass");
  };

  const run = useCallback(async (cell: CodeCell, current: Record<string, string>): Promise<boolean> => {
    if (!api) return false;
    const rid = newRunId();
    setCells((cs) => ({ ...cs, [cell.id]: { ...emptyCell(), running: true, runId: rid, outcome: cs[cell.id]?.outcome ?? null, stale: true } }));
    try {
      const r = await api.runCell(id, cell.id, current, rid);
      Object.assign(saved.current, current);
      return finishCell(cell.id, r);
    } catch (e) {
      patch(cell.id, { running: false, runId: null, error: String((e as Error).message ?? e) });
      return false;
    }
  }, [api, id, patch]);   // finishCell only sets state

  const runAll = async () => {
    setAll(true);
    stopAll.current = false;
    for (const c of code) {
      if (stopAll.current || !(await run(c, files))) break;
    }
    setAll(false);
  };

  const dismissAnnotation = (a: Annotation) => {
    setAnnotations((xs) => xs.filter((x) => x.id !== a.id));
    getBackend().deleteAnnotation(shim, a.id).catch(() => undefined);
  };
  const resolveProposal = async (p: Proposal, action: "accept" | "reject") => {
    setProposals((xs) => xs.filter((x) => x.id !== p.id));
    try {
      const r = await getBackend().resolveProposal(shim, p.id, action);
      if (action === "accept") applyFiles(r.files);
    } catch {
      setReloadKey((k) => k + 1);   // out of date: show what is stored
    }
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

  const index = list.findIndex((t) => t.id === id);
  const go = (offset: number) => {
    if (!list.length) return;
    const next = list[(index + offset + list.length) % list.length];
    if (next && next.id !== id) navigate(`/t/${next.id}`);
  };

  const done = (c: CodeCell) => isComplete(cells[c.id], c.has_checks);
  const anyRunning = Object.values(cells).some((c) => c.running);

  return (
    <div className="list-page">
      <header className="topbar balanced">
        <div className="topbar-side">
          <Brand />
          <span className="topbar-divider" />
          <Button variant="ghost" icon={List} onClick={() => setDrawerOpen(true)}>
            Tutorial List
          </Button>
          <IconButton icon={ChevronLeft} label="Previous tutorial" onClick={() => go(-1)} disabled={list.length < 2} />
          <IconButton icon={ChevronRight} label="Next tutorial" onClick={() => go(1)} disabled={list.length < 2} />
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
            <header className="t-head">
              <h1 className="page-title">{tutorial.title}</h1>
              {tutorial.summary && <p className="muted">{tutorial.summary}</p>}
              <p className="t-count tabular">
                {code.filter(done).length} of {code.length} steps done
              </p>
            </header>
            {annotations.some((a) => !a.file) && (
              <div className="t-general">
                <CellNotes annotations={annotations.filter((a) => !a.file)} onDismiss={dismissAnnotation} />
              </div>
            )}
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
                    tutorialId={tutorial.id}
                    uri={`inmemory://tutorial/${tutorial.id}/${c.path}`}
                    code={files[c.path] ?? c.starter}
                    modified={(files[c.path] ?? c.starter) !== c.starter}
                    state={state}
                    hasChecks={c.has_checks}
                    dark={dark}
                    annotations={annotations.filter((a) => a.file === c.path)}
                    proposal={proposals.find((p) => p.file === c.path) ?? null}
                    onFocus={() => setActive(c.path)}
                    onCursor={setCursor}
                    onDismissAnnotation={dismissAnnotation}
                    onResolveProposal={(p, action) => void resolveProposal(p, action)}
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
      <TutorialDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} tutorials={list} currentId={id} />
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
