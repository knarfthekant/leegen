import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Editor, type CursorInfo, type EditorFile } from "../components/Editor";
import { Markdown } from "../components/Markdown";
import { ResultPanel } from "../components/ResultPanel";
import { ReviewPanel } from "../components/ReviewPanel";
import { TestcasePanel } from "../components/TestcasePanel";
import {
  api,
  newRunId,
  type Annotation,
  type CustomTest,
  type ExecutorInfo,
  type Problem,
  type ProblemSummary,
  type Proposal,
  type RunResult,
} from "../lib/api";
import { useServerEvents } from "../lib/events";
import { navigate } from "../lib/router";
import { useDark } from "../lib/theme";

type BottomTab = "testcase" | "result" | "review";

function useDebounced(fn: () => void, deps: unknown[], ms: number) {
  useEffect(() => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function WorkspacePage({ id }: { id: string }) {
  const dark = useDark();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [problems, setProblems] = useState<ProblemSummary[]>([]);
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string>("");
  const [customTests, setCustomTests] = useState<CustomTest[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [hintsRevealed, setHintsRevealed] = useState(0);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runPhase, setRunPhase] = useState<{ phase: string; detail: string } | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>("testcase");
  const [leftTab, setLeftTab] = useState<"description" | "hints">("description");
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [executor, setExecutor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [revealLine, setRevealLine] = useState<{ path: string; line: number; nonce: number } | null>(null);

  const runId = useRef<string | null>(null);
  const saved = useRef<Record<string, string>>({});
  const loaded = useRef<string | null>(null);

  // ---------------------------------------------------------------- loading
  const loadProblem = useCallback(
    () =>
      api.problem(id).then(setProblem, (e) => {
        setLoadError(String(e.message ?? e));
      }),
    [id],
  );

  useEffect(() => {
    let alive = true;
    loaded.current = null;
    setProblem(null);
    setLoadError(null);
    setResult(null);
    setBottomTab("testcase");
    setLeftTab("description");
    Promise.all([api.problem(id), api.workspace(id), api.executors(id), api.problems()])
      .then(([p, w, ex, list]) => {
        if (!alive) return;
        setProblem(p);
        setBuffers(w.files);
        saved.current = { ...w.files };
        setCustomTests(w.custom_tests);
        setAnnotations(w.annotations);
        setProposals(w.proposals);
        setHintsRevealed(w.hints_revealed);
        setResult(w.last_run);
        setExecutors(ex.executors);
        const firstCompatible = ex.executors.find((e) => e.compatible);
        setExecutor(firstCompatible?.id ?? null);
        setProblems(list.problems);
        setActive(p.files.find((f) => f.role === "editable")?.path ?? p.files[0]?.path ?? "");
        loaded.current = id;
      })
      .catch((e) => alive && setLoadError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [id]);

  // ---------------------------------------------------------------- persistence
  useDebounced(
    () => {
      if (loaded.current !== id) return;
      const changed = Object.fromEntries(Object.entries(buffers).filter(([k, v]) => saved.current[k] !== v));
      if (Object.keys(changed).length === 0) return;
      api.saveFiles(id, changed).then(() => Object.assign(saved.current, changed));
    },
    [buffers, id],
    500,
  );

  useDebounced(
    () => {
      if (loaded.current !== id) return;
      api
        .session({
          problem_id: id,
          buffers,
          active_file: active,
          cursor: cursor ? { line: cursor.line, column: cursor.column } : null,
          selection: cursor?.selection ?? null,
          executor,
        })
        .catch(() => undefined);
    },
    [buffers, active, cursor, executor, id],
    400,
  );

  const changeCustomTests = (tests: CustomTest[]) => {
    setCustomTests(tests);
    api.saveCustomTests(id, tests);
  };

  // ---------------------------------------------------------------- run
  const run = useCallback(async () => {
    if (running || !problem) return;
    const rid = newRunId();
    runId.current = rid;
    setRunning(true);
    setBottomTab("result");
    try {
      const r = await api.run(id, buffers, executor, rid);
      Object.assign(saved.current, buffers);
      setResult(r);
    } catch (e) {
      setResult({
        run_id: rid, problem_id: id, status: "error", executor: executor ?? "-", device: null,
        started_at: Date.now() / 1000, duration_ms: 0, passed: 0, total: 0, tests: [], metrics: [],
        compile_output: null, error: String((e as Error).message ?? e), stdout: "", stderr: "",
      });
    } finally {
      runId.current = null;
      setRunning(false);
    }
  }, [running, problem, id, buffers, executor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);

  // ---------------------------------------------------------------- server events
  useServerEvents((e) => {
    if (e.type === "navigate" && typeof e.problem_id === "string") {
      navigate(`/p/${e.problem_id}`);
      return;
    }
    if (e.type === "problems_changed") {
      api.problems().then((r) => setProblems(r.problems));
    }
    if (e.problem_id !== id) return;
    switch (e.type) {
      case "run_started":
        setRunPhase(null);
        if (e.run_id !== runId.current) {
          setRunning(true);
          setBottomTab("result");
        }
        break;
      case "run_status":
        setRunPhase({ phase: String(e.phase), detail: String(e.detail ?? "") });
        break;
      case "run_finished":
        setRunPhase(null);
        if (e.run_id !== runId.current) {
          setRunning(false);
          setResult(e.result as RunResult);
        }
        break;
      case "annotations_changed": {
        const next = e.annotations as Annotation[];
        setAnnotations((prev) => {
          if (next.length > prev.length) setBottomTab("review");
          return next;
        });
        break;
      }
      case "proposals_changed": {
        const next = e.proposals as Proposal[];
        setProposals(next);
        const latest = next[next.length - 1];
        if (latest && e.added) setActive(latest.file);
        break;
      }
      case "files_changed": {
        const files = e.files as Record<string, string>;
        Object.assign(saved.current, files);
        setBuffers((b) => ({ ...b, ...files }));
        break;
      }
      case "custom_tests_changed":
        setCustomTests(e.tests as CustomTest[]);
        break;
      case "problem_changed":
        loadProblem();
        break;
    }
  });

  // ---------------------------------------------------------------- derived
  const editorFiles: EditorFile[] = useMemo(
    () =>
      (problem?.files ?? []).map((f) => ({
        path: f.path,
        role: f.role,
        language: f.language,
        content: f.role === "editable" ? (buffers[f.path] ?? f.content) : f.content,
      })),
    [problem, buffers],
  );
  const activeProposal = proposals.find((p) => p.file === active) ?? null;

  const resolveProposal = async (p: Proposal, action: "accept" | "reject") => {
    const r = await api.resolveProposal(id, p.id, action);
    setProposals((ps) => ps.filter((x) => x.id !== p.id));
    if (action === "accept" && r.files) {
      Object.assign(saved.current, r.files);
      setBuffers((b) => ({ ...b, ...r.files }));
    }
  };

  const reset = async () => {
    if (!confirm("Reset all editable files to the starter code?")) return;
    const r = await api.reset(id);
    saved.current = { ...r.files };
    setBuffers(r.files);
  };

  // ---------------------------------------------------------------- render
  if (loadError)
    return (
      <div className="list-page">
        <header className="topbar">
          <button className="brand link" onClick={() => navigate("/")}>leetclaude</button>
        </header>
        <main className="list-main">
          <pre className="error-block">{loadError}</pre>
        </main>
      </div>
    );
  if (!problem) return <div className="loading-page muted">Loading…</div>;

  const compatible = executors.filter((e) => e.compatible);
  const reviewCount = annotations.length + proposals.length;

  return (
    <div className="ws-page">
      <header className="topbar">
        <button className="brand link" onClick={() => navigate("/")}>leetclaude</button>
        <select className="picker" value={id} onChange={(e) => navigate(`/p/${e.target.value}`)}>
          {problems.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <select
          className="executor"
          value={executor ?? ""}
          onChange={(e) => setExecutor(e.target.value)}
          title="Where the code runs"
          disabled={compatible.length === 0}
        >
          {compatible.length === 0 && <option value="">No executor provides {problem.requires.join(", ")}</option>}
          {compatible.map((e) => (
            <option key={e.id} value={e.id}>
              {problem.environment} · {e.id} ({e.device})
            </option>
          ))}
        </select>
        <button className="primary run" onClick={run} disabled={running || compatible.length === 0} title="Run (⌘↵)">
          {running ? (runPhase?.phase === "queued" ? "Queued…" : "Running…") : "Run"}
        </button>
      </header>

      <Group orientation="horizontal" className="ws-main">
        <Panel defaultSize="42%" minSize="20%" className="pane">
          <div className="pane-tabs">
            <button className={"tab" + (leftTab === "description" ? " active" : "")} onClick={() => setLeftTab("description")}>
              Description
            </button>
            <button className={"tab" + (leftTab === "hints" ? " active" : "")} onClick={() => setLeftTab("hints")}>
              Hints{problem.hints.length ? ` (${hintsRevealed}/${problem.hints.length})` : ""}
            </button>
          </div>
          <div className="pane-body description">
            {leftTab === "description" ? (
              <>
                <h1 className="title">{problem.title}</h1>
                <div className="meta">
                  <span className={`diff diff-${problem.difficulty}`}>{problem.difficulty}</span>
                  <span className="tag">{problem.environment}</span>
                  {problem.requires.filter((r) => r !== "cpu").map((r) => (
                    <span key={r} className="tag">{r}</span>
                  ))}
                  {problem.tags.filter((t) => t !== problem.environment).map((t) => (
                    <span key={t} className="tag subtle">{t}</span>
                  ))}
                </div>
                <Markdown source={problem.description} problemId={problem.id} />
              </>
            ) : (
              <Hints
                hints={problem.hints}
                revealed={hintsRevealed}
                onReveal={() => {
                  const n = Math.min(hintsRevealed + 1, problem.hints.length);
                  setHintsRevealed(n);
                  api.saveHints(id, n);
                }}
              />
            )}
          </div>
        </Panel>
        <Separator className="sep sep-v" />
        <Panel minSize="30%" className="pane">
          <Group orientation="vertical">
            <Panel defaultSize="62%" minSize="15%" className="pane">
              <Editor
                problemId={problem.id}
                files={editorFiles}
                active={active}
                onSelect={setActive}
                onChange={(path, value) => setBuffers((b) => ({ ...b, [path]: value }))}
                annotations={annotations}
                proposal={activeProposal}
                onResolveProposal={resolveProposal}
                onRun={run}
                onCursor={setCursor}
                onReset={reset}
                revealLine={revealLine}
                dark={dark}
              />
            </Panel>
            <Separator className="sep sep-h" />
            <Panel minSize="12%" className="pane">
              <div className="pane-tabs">
                {(["testcase", "result", "review"] as BottomTab[]).map((t) => (
                  <button key={t} className={"tab" + (bottomTab === t ? " active" : "")} onClick={() => setBottomTab(t)}>
                    {t === "testcase" ? "Testcase" : t === "result" ? "Result" : "Review"}
                    {t === "review" && reviewCount > 0 && <span className="count">{reviewCount}</span>}
                    {t === "result" && result && !running && (
                      <span className={"status-dot " + (result.status === "passed" ? "pass" : "fail")} />
                    )}
                  </button>
                ))}
              </div>
              <div className="pane-body">
                {bottomTab === "testcase" && (
                  <TestcasePanel
                    problem={problem}
                    customTests={customTests}
                    onChangeCustom={changeCustomTests}
                    onOpenFile={setActive}
                  />
                )}
                {bottomTab === "result" && (
                  <ResultPanel
                    result={result}
                    running={running}
                    phase={runPhase}
                    params={problem.judge.params ?? []}
                    onCancel={() => runId.current && api.cancel(runId.current)}
                  />
                )}
                {bottomTab === "review" && (
                  <ReviewPanel
                    annotations={annotations}
                    proposals={proposals}
                    onJump={(file, line) => {
                      setActive(file);
                      setRevealLine({ path: file, line, nonce: Date.now() });
                    }}
                    onDismiss={(a) => {
                      setAnnotations((xs) => xs.filter((x) => x.id !== a.id));
                      api.deleteAnnotation(id, a.id);
                    }}
                    onOpenProposal={(p) => setActive(p.file)}
                  />
                )}
              </div>
            </Panel>
          </Group>
        </Panel>
      </Group>
    </div>
  );
}

function Hints({ hints, revealed, onReveal }: { hints: string[]; revealed: number; onReveal: () => void }) {
  if (!hints.length) return <p className="muted">This problem has no hints. Ask your AI assistant for one.</p>;
  return (
    <div className="hints">
      {hints.slice(0, revealed).map((h, i) => (
        <div key={i} className="hint">
          <div className="field-label">Hint {i + 1}</div>
          <Markdown source={h} />
        </div>
      ))}
      {revealed < hints.length ? (
        <button onClick={onReveal}>Show hint {revealed + 1} of {hints.length}</button>
      ) : (
        <p className="muted small">All hints shown.</p>
      )}
    </div>
  );
}
