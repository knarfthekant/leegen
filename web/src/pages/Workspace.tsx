import {
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Cpu,
  FileText,
  Lightbulb,
  List,
  Lock,
  MessageSquare,
  Play,
  Shuffle,
  Square,
  SquareCheck,
  Tag,
  Terminal,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { Brand, ConnectionDot, ThemeToggle } from "../components/Chrome";
import { Editor, type CursorInfo, type EditorFile, type RevealTarget, type SaveState } from "../components/Editor";
import { Markdown } from "../components/Markdown";
import { ProblemDrawer } from "../components/ProblemDrawer";
import { ElsewhereChip, elsewhere, hardware } from "../components/ProblemRow";
import { ResultPanel } from "../components/ResultPanel";
import { ReviewPanel } from "../components/ReviewPanel";
import { TestcasePanel } from "../components/TestcasePanel";
import { Button, Chip, DifficultyChip, IconButton, Select, Skeleton, Tabs } from "../components/ui";
import { eventProblemId, getBackend, useBackendEvents } from "../backend";
import {
  newRunId,
  type Annotation,
  type CustomTest,
  type ExecutorInfo,
  type Problem,
  type ProblemSummary,
  type Proposal,
  type RunResult,
} from "../lib/api";
import { navigate } from "../lib/router";
import { useDark } from "../lib/theme";

type BottomTab = "testcase" | "result" | "review";
type LeftTab = "description" | "hints";

const BOTTOM_HEAD_PX = 42; // height of the bottom card's tab strip; the collapsed size

function useDebounced(fn: () => void, deps: unknown[], ms: number) {
  useEffect(() => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

const isGpu = (device: string | null | undefined) => !!device && !/^cpu/i.test(device);

export function WorkspacePage({ id }: { id: string }) {
  const api = getBackend();
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
  const [leftTab, setLeftTab] = useState<LeftTab>("description");
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [runtimes, setRuntimes] = useState<string[] | undefined>(undefined);
  const [executor, setExecutor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [revealLine, setRevealLine] = useState<RevealTarget | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const runId = useRef<string | null>(null);
  const saved = useRef<Record<string, string>>({});
  const loaded = useRef<string | null>(null);
  const leftPanel = usePanelRef();
  const bottomPanel = usePanelRef();

  /** Switch the bottom card to a tab, expanding it if it was collapsed. */
  const showBottom = useCallback(
    (tab: BottomTab) => {
      setBottomTab(tab);
      if (bottomPanel.current?.isCollapsed()) bottomPanel.current.expand();
    },
    [bottomPanel],
  );

  // ---------------------------------------------------------------- loading
  const loadProblem = useCallback(
    () =>
      api.getProblem(id).then(setProblem, (e) => {
        setLoadError(String(e.message ?? e));
      }),
    [api, id],
  );

  useEffect(() => {
    let alive = true;
    loaded.current = null;
    setProblem(null);
    setLoadError(null);
    setResult(null);
    setBottomTab("testcase");
    setLeftTab("description");
    setSaveState("saved");
    Promise.all([api.getProblem(id), api.getWorkspace(id), api.executors(id), api.listProblems()])
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
        setRuntimes(ex.runtimes);
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
  }, [api, id]);

  // ---------------------------------------------------------------- persistence
  useDebounced(
    () => {
      if (loaded.current !== id) return;
      const changed = Object.fromEntries(Object.entries(buffers).filter(([k, v]) => saved.current[k] !== v));
      if (Object.keys(changed).length === 0) {
        setSaveState((s) => (s === "saving" ? "saved" : s));
        return;
      }
      setSaveState("saving");
      api.saveFiles(id, changed).then(
        () => {
          Object.assign(saved.current, changed);
          setSaveState("saved");
        },
        () => setSaveState("error"),
      );
    },
    [buffers, id],
    500,
  );

  useDebounced(
    () => {
      if (loaded.current !== id) return;
      api
        .reportSession({
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
    showBottom("result");
    try {
      const r = await api.run(id, buffers, executor, rid);
      Object.assign(saved.current, buffers);
      setSaveState("saved");
      setResult(r);
    } catch (e) {
      setResult({
        run_id: rid, problem_id: id, status: "error", executor: executor ?? "-", device: null,
        started_at: Date.now() / 1000, duration_ms: 0, passed: 0, total: 0, tests: [], metrics: [],
        compile_output: null, error: String((e as Error).message ?? e), stdout: "", stderr: "",
        mode: "user",
      });
    } finally {
      runId.current = null;
      setRunning(false);
    }
  }, [api, running, problem, id, buffers, executor, showBottom]);

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

  // ---------------------------------------------------------------- backend events
  useBackendEvents((e) => {
    if (e.type === "navigate") {
      navigate(`/p/${e.problem_id}`);
      return;
    }
    if (e.type === "problems_changed" || e.type === "run_finished") {
      api.listProblems().then((r) => setProblems(r.problems));
    }
    if (eventProblemId(e) !== id) return;
    switch (e.type) {
      case "run_started":
        setRunPhase(null);
        if (e.run_id !== runId.current) {
          setRunning(true);
          showBottom("result");
        }
        break;
      case "run_status":
        setRunPhase({ phase: e.phase, detail: e.detail ?? "" });
        break;
      case "run_finished":
        setRunPhase(null);
        if (e.run_id !== runId.current) {
          setRunning(false);
          setResult(e.result);
        }
        break;
      case "annotations_changed": {
        const next = e.annotations;
        setAnnotations((prev) => {
          if (next.length > prev.length) showBottom("review");
          return next;
        });
        break;
      }
      case "proposals_changed": {
        const next = e.proposals;
        setProposals(next);
        const latest = next[next.length - 1];
        if (latest && e.added) setActive(latest.file);
        break;
      }
      case "files_changed": {
        const files = e.files;
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
  const index = problems.findIndex((p) => p.id === id);

  const go = (offset: number) => {
    if (!problems.length) return;
    const next = problems[(index + offset + problems.length) % problems.length];
    if (next && next.id !== id) navigate(`/p/${next.id}`);
  };
  const shuffle = () => {
    const others = problems.filter((p) => p.id !== id);
    if (others.length) navigate(`/p/${others[Math.floor(Math.random() * others.length)].id}`);
  };

  const toggleMaximize = () => {
    if (maximized) {
      leftPanel.current?.expand();
      bottomPanel.current?.expand();
    } else {
      leftPanel.current?.collapse();
      bottomPanel.current?.collapse();
    }
    setMaximized(!maximized);
  };

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
    const r = await api.resetWorkspace(id);
    saved.current = { ...r.files };
    setBuffers(r.files);
  };

  // ---------------------------------------------------------------- render
  if (loadError)
    return (
      <div className="list-page">
        <header className="topbar">
          <Brand />
        </header>
        <main className="list-main">
          <div className="soft-alert tone-fail">
            <CircleAlert size={16} strokeWidth={1.9} />
            <div className="soft-alert-body">
              <strong>Could not open “{id}”</strong>
              <pre>{loadError}</pre>
            </div>
          </div>
        </main>
      </div>
    );
  if (!problem) return <WorkspaceSkeleton />;

  const compatible = executors.filter((e) => e.compatible);
  const selected = compatible.find((e) => e.id === executor);
  const reviewCount = annotations.length + proposals.length;
  const hw = hardware(problem);

  return (
    <div className="ws-page">
      <header className="topbar">
        <div className="topbar-side">
          <Brand />
          <span className="topbar-divider" />
          <Button variant="ghost" icon={List} onClick={() => setDrawerOpen(true)}>
            Problem List
          </Button>
          <IconButton icon={ChevronLeft} label="Previous problem" onClick={() => go(-1)} disabled={problems.length < 2} />
          <IconButton icon={ChevronRight} label="Next problem" onClick={() => go(1)} disabled={problems.length < 2} />
          <IconButton icon={Shuffle} label="Random problem" onClick={shuffle} disabled={problems.length < 2} />
        </div>

        <div className="run-cluster">
          <Select
            icon={isGpu(selected?.device) ? Zap : Cpu}
            className="executor"
            value={executor ?? ""}
            onChange={(e) => setExecutor(e.target.value)}
            title="Where the code runs"
            disabled={compatible.length === 0}
          >
            {compatible.length === 0 && (
              <option value="">
                {elsewhere(runtimes) ? `Runs in the ${elsewhere(runtimes)!.label}` : `No executor provides ${problem.requires.join(", ")}`}
              </option>
            )}
            {compatible.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id} · {e.device}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            className="run"
            icon={Play}
            loading={running}
            onClick={run}
            disabled={running || compatible.length === 0}
            title="Run (⌘↵)"
          >
            {running ? (runPhase?.phase === "queued" ? "Queued…" : "Running…") : "Run"}
          </Button>
          {running && (
            <IconButton icon={Square} label="Cancel run" size={14} onClick={() => runId.current && api.cancel(runId.current)} />
          )}
        </div>

        <div className="topbar-side end">
          <ConnectionDot />
          <ThemeToggle />
        </div>
      </header>

      <Group orientation="horizontal" className="ws-main">
        <Panel
          panelRef={leftPanel}
          defaultSize="42%"
          minSize="20%"
          collapsible
          collapsedSize={0}
          className="pane"
          onResize={() => {
            if (maximized && !leftPanel.current?.isCollapsed()) setMaximized(false);
          }}
        >
          <section className="card">
            <Tabs<LeftTab>
              className="card-head"
              value={leftTab}
              onChange={setLeftTab}
              items={[
                { id: "description", label: "Description", icon: FileText },
                {
                  id: "hints",
                  label: "Hints",
                  icon: Lightbulb,
                  badge: problem.hints.length ? `${hintsRevealed}/${problem.hints.length}` : null,
                },
              ]}
            />
            <div className="card-body description" key={leftTab}>
              {leftTab === "description" ? (
                <>
                  <h1 className="title">
                    {index >= 0 && <span className="title-index">{index + 1}.</span>} {problem.title}
                  </h1>
                  <MetaChips problem={problem} hw={hw} runtimes={runtimes} />
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
          </section>
        </Panel>
        <Separator className="sep sep-v">
          <span className="grip" />
        </Separator>
        <Panel minSize="30%" className="pane">
          <Group orientation="vertical">
            <Panel defaultSize="62%" minSize="15%" className="pane">
              <section className="card">
                <Editor
                  problemId={problem.id}
                  files={editorFiles}
                  active={active}
                  onSelect={setActive}
                  onChange={(path, value) => {
                    setBuffers((b) => ({ ...b, [path]: value }));
                    setSaveState("saving");
                  }}
                  annotations={annotations}
                  proposal={activeProposal}
                  onResolveProposal={resolveProposal}
                  onRun={run}
                  onCursor={setCursor}
                  onReset={reset}
                  revealLine={revealLine}
                  selectedAnnotationId={selectedAnnotationId}
                  onSelectAnnotation={(aid) => {
                    setSelectedAnnotationId(aid);
                    if (aid) showBottom("review");
                  }}
                  dark={dark}
                  saveState={saveState}
                  cursor={cursor}
                  maximized={maximized}
                  onToggleMaximize={toggleMaximize}
                />
              </section>
            </Panel>
            <Separator className="sep sep-h">
              <span className="grip" />
            </Separator>
            <Panel
              panelRef={bottomPanel}
              minSize="14%"
              collapsible
              collapsedSize={BOTTOM_HEAD_PX}
              className="pane"
              onResize={() => setBottomCollapsed(!!bottomPanel.current?.isCollapsed())}
            >
              <section className={"card" + (bottomCollapsed ? " collapsed" : "")}>
                <Tabs<BottomTab>
                  className="card-head"
                  value={bottomTab}
                  onChange={showBottom}
                  onActiveClick={() => bottomPanel.current?.isCollapsed() && bottomPanel.current.expand()}
                  items={[
                    { id: "testcase", label: "Testcase", icon: SquareCheck },
                    {
                      id: "result",
                      label: "Test Result",
                      icon: Terminal,
                      dot: result && !running ? (result.status === "passed" ? "pass" : "fail") : null,
                    },
                    { id: "review", label: "Review", icon: MessageSquare, badge: reviewCount > 0 ? reviewCount : null },
                  ]}
                  trailing={
                    <IconButton
                      icon={bottomCollapsed ? ChevronUp : ChevronDown}
                      label={bottomCollapsed ? "Expand panel" : "Collapse panel"}
                      onClick={() => (bottomCollapsed ? bottomPanel.current?.expand() : bottomPanel.current?.collapse())}
                    />
                  }
                />
                <div className="card-body" key={bottomTab}>
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
                      sections={problem.sections}
                      onCancel={() => runId.current && api.cancel(runId.current)}
                    />
                  )}
                  {bottomTab === "review" && (
                    <ReviewPanel
                      annotations={annotations}
                      proposals={proposals}
                      selectedId={selectedAnnotationId}
                      onSelect={(a) => {
                        setSelectedAnnotationId(a?.id ?? null);
                        if (!a || !a.file || a.start_line == null) return;
                        setActive(a.file);
                        setRevealLine({
                          path: a.file,
                          line: a.start_line,
                          endLine: a.end_line ?? a.start_line,
                          col: a.start_col ?? undefined,
                          endCol: a.end_col ?? undefined,
                          nonce: Date.now(),
                        });
                      }}
                      onDismiss={(a) => {
                        setSelectedAnnotationId((cur) => (cur === a.id ? null : cur));
                        setAnnotations((xs) => xs.filter((x) => x.id !== a.id));
                        api.deleteAnnotation(id, a.id);
                      }}
                      onOpenProposal={(p) => setActive(p.file)}
                    />
                  )}
                </div>
              </section>
            </Panel>
          </Group>
        </Panel>
      </Group>

      <ProblemDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} problems={problems} currentId={id} />
    </div>
  );
}

function MetaChips({ problem, hw, runtimes }: { problem: Problem; hw: string[]; runtimes?: string[] }) {
  const tags = problem.tags.filter((t) => t !== problem.environment);
  const [showTopics, setShowTopics] = useState(tags.length <= 3);
  return (
    <div className="meta">
      <DifficultyChip value={problem.difficulty} />
      <Chip icon={Box} title="Environment">
        {problem.environment}
      </Chip>
      {hw.map((r) => (
        <Chip key={r} icon={Zap} title="Required hardware">
          {r}
        </Chip>
      ))}
      <ElsewhereChip runtimes={runtimes} />
      {tags.length > 0 &&
        (showTopics ? (
          tags.map((t) => (
            <Chip key={t} icon={Tag}>
              {t}
            </Chip>
          ))
        ) : (
          <Chip icon={Tag} onClick={() => setShowTopics(true)} title={tags.join(", ")}>
            Topics · {tags.length}
          </Chip>
        ))}
    </div>
  );
}

function Hints({ hints, revealed, onReveal }: { hints: string[]; revealed: number; onReveal: () => void }) {
  if (!hints.length)
    return (
      <div className="empty">
        <Lightbulb size={20} strokeWidth={1.6} />
        <span>This problem has no hints. Ask your AI assistant for one.</span>
      </div>
    );
  return (
    <div className="hints">
      {hints.map((h, i) =>
        i < revealed ? (
          <details key={i} className="hint" open>
            <summary>
              <Lightbulb size={15} strokeWidth={1.8} />
              Hint {i + 1}
              <ChevronDown size={15} className="hint-chevron" />
            </summary>
            <div className="hint-body">
              <Markdown source={h} />
            </div>
          </details>
        ) : i === revealed ? (
          <button key={i} className="hint locked next" onClick={onReveal}>
            <Lightbulb size={15} strokeWidth={1.8} />
            Reveal hint {i + 1} of {hints.length}
          </button>
        ) : (
          <div key={i} className="hint locked">
            <Lock size={14} strokeWidth={1.8} />
            Hint {i + 1}
          </div>
        ),
      )}
      {revealed >= hints.length && <p className="muted small">All hints shown.</p>}
    </div>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="ws-page">
      <header className="topbar">
        <Brand />
      </header>
      <div className="ws-skeleton">
        <section className="card">
          <div className="card-body description skeleton-stack">
            <Skeleton w="55%" h={24} />
            <Skeleton w="30%" h={20} r={10} />
            <Skeleton />
            <Skeleton w="92%" />
            <Skeleton w="80%" />
          </div>
        </section>
        <div className="ws-skeleton-right">
          <section className="card" style={{ flex: 62 }} />
          <section className="card" style={{ flex: 38 }} />
        </div>
      </div>
    </div>
  );
}
