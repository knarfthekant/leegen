import { BookOpen, CircleAlert, Inbox, ListChecks, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Brand, ConnectionDot, RepositoryLink, ThemeToggle } from "../components/Chrome";
import { ImportReport, SavedReport, TransferButtons } from "../components/Transfer";
import type { ImportSummary } from "../backend/types";
import { filterProblems, ProblemRow, StatusIcon } from "../components/ProblemRow";
import { Chip, cx, DIFFICULTY_TONE, IconButton, Segmented, Skeleton, type Tone } from "../components/ui";
import { getBackend, useBackendEvents } from "../backend";
import { type Difficulty, type ProblemSummary, type TutorialSummary } from "../lib/api";
import { href as appHref, navigate } from "../lib/router";

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

type View = "practice" | "tutorials";
const VIEWS: View[] = ["practice", "tutorials"];

const initialView = (): View =>
  new URLSearchParams(location.search).get("view") === "tutorials" ? "tutorials" : "practice";

/** Remember the view in the URL without adding history entries, so Back from a tutorial lands here. */
function rememberView(view: View) {
  const url = new URL(location.href);
  if (view === "tutorials") url.searchParams.set("view", "tutorials");
  else url.searchParams.delete("view");
  history.replaceState(history.state, "", url);
}

export function ProblemList() {
  const [problems, setProblems] = useState<ProblemSummary[]>([]);
  const [errors, setErrors] = useState<{ path: string; error: string }[]>([]);
  const [errorsHidden, setErrorsHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [imported, setImported] = useState<(ImportSummary & { folder?: string }) | null>(null);
  const [saved, setSaved] = useState<{ folder: string; written: number } | null>(null);
  const [tutorials, setTutorials] = useState<TutorialSummary[] | null>(null);

  // Tutorials exist only in the server edition for now; without them there is nothing to switch.
  const tutorialApi = getBackend().tutorials;
  const [view, setViewState] = useState<View>(() => (tutorialApi ? initialView() : "practice"));
  const direction = useRef(0);
  const setView = (next: View) => {
    if (next === view) return;
    direction.current = VIEWS.indexOf(next) > VIEWS.indexOf(view) ? 1 : -1;
    setViewState(next);
    rememberView(next);
  };

  useEffect(() => {
    tutorialApi?.list().then((r) => setTutorials(r.tutorials), () => setTutorials([]));
  }, [tutorialApi]);

  const load = () =>
    getBackend().listProblems().then((r) => {
      setProblems(r.problems);
      setErrors(r.errors);
      setLoading(false);
    });
  useEffect(() => {
    load();
  }, []);
  useBackendEvents((e) => {
    if (e.type === "problems_changed" || e.type === "run_finished") load();
    if (e.type === "navigate") navigate(`/p/${e.problem_id}`);
  });
  const browser = getBackend().edition === "browser";

  return (
    <div className="list-page">
      <header className="topbar">
        <div className="topbar-side">
          <Brand />
        </div>
        <div className="spacer" />
        <div className="topbar-side end">
          <TransferButtons
            onImported={(s) => {
              setSaved(null);
              setImported(s);
            }}
            onSaved={(s) => {
              setImported(null);
              setSaved(s);
            }}
          />
          <ConnectionDot />
          {browser && <RepositoryLink />}
          <ThemeToggle />
        </div>
      </header>
      <main className="list-main">
        {/* the switch sits in the content column, on the title's left edge, and never moves */}
        {tutorialApi && (
          <div className="mode-row">
            <Segmented<View>
              label="Mode"
              className="mode-switch"
              value={view}
              onChange={setView}
              items={[
                { id: "practice", label: "Practice", icon: ListChecks, count: loading ? null : problems.length },
                { id: "tutorials", label: "Tutorials", icon: BookOpen, count: tutorials ? tutorials.length : null },
              ]}
            />
          </div>
        )}
        {/* only this pane changes on a switch: it is keyed, so it re-enters from the switch's side */}
        <div className="view-pane" key={view} style={{ "--dir": direction.current } as CSSProperties}>
          {view === "tutorials" ? (
            <TutorialsView tutorials={tutorials} />
          ) : (
            <PracticeView
              problems={problems}
              loading={loading}
              browser={browser}
              errors={errorsHidden ? [] : errors}
              onDismissErrors={() => setErrorsHidden(true)}
              notices={
                <>
                  {imported && <ImportReport summary={imported} onClose={() => setImported(null)} />}
                  {saved && <SavedReport saved={saved} onClose={() => setSaved(null)} />}
                </>
              }
            />
          )}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ shared page pieces */

function Hero({ title, subtitle, aside }: { title: string; subtitle: string; aside: ReactNode }) {
  return (
    <div className="list-hero">
      <div className="hero-text">
        <h1 className="page-title">{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      <div className="hero-side">{aside}</div>
    </div>
  );
}

function Toolbar({
  query,
  onQuery,
  placeholder,
  children,
}: {
  query: string;
  onQuery: (q: string) => void;
  placeholder: string;
  children?: ReactNode;
}) {
  return (
    <div className="list-toolbar">
      <label className="search-field">
        <Search size={15} strokeWidth={1.8} />
        <input placeholder={placeholder} value={query} onChange={(e) => onQuery(e.target.value)} />
      </label>
      <div className="chip-row">{children}</div>
    </div>
  );
}

function Empty({ icon: Icon, children }: { icon: typeof Inbox; children: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={22} strokeWidth={1.6} />
      <span>{children}</span>
    </div>
  );
}

function RowSkeletons() {
  return (
    <>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="problem-row">
          <Skeleton w={16} h={16} r={8} />
          <Skeleton w={`${40 + ((i * 17) % 30)}%`} />
        </div>
      ))}
    </>
  );
}

/** The ring and bars in a page's corner: how far along the learner is. */
function ProgressCard({
  done,
  total,
  loading,
  unit,
  bars,
}: {
  done: number;
  total: number;
  loading: boolean;
  unit: string;
  bars: { key: string; label: string; tone: Tone; done: number; all: number }[];
}) {
  const pct = total ? done / total : 0;
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="card progress-card">
      <div className="ring" title={`${done} of ${total} ${unit}`}>
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <circle cx="32" cy="32" r={r} className="ring-track" />
          <circle cx="32" cy="32" r={r} className="ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
        </svg>
        <div className="ring-label tabular">
          <strong>{loading ? "–" : done}</strong>
          <span>/{total}</span>
        </div>
      </div>
      <div className="bars">
        {bars.map((b) => (
          <div key={b.key} className="bar-row">
            <span className={`cap tone-text-${b.tone}`}>{b.label}</span>
            <span className={`bar tone-${b.tone}`}>
              <span style={{ width: `${b.all ? (b.done / b.all) * 100 : 0}%` }} />
            </span>
            <span className="tabular muted small">
              {b.done}/{b.all}
            </span>
          </div>
        ))}
        {!loading && total === 0 && <span className="muted small">Nothing here yet</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ practice */

function PracticeView({
  problems,
  loading,
  browser,
  errors,
  onDismissErrors,
  notices,
}: {
  problems: ProblemSummary[];
  loading: boolean;
  browser: boolean;
  errors: { path: string; error: string }[];
  onDismissErrors: () => void;
  notices: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [track, setTrack] = useState<string | null>(null);
  const tracks = useMemo(() => [...new Set(problems.map((p) => p.track).filter((t): t is string => !!t))], [problems]);
  const filtered = useMemo(
    () =>
      filterProblems(problems, query).filter(
        (p) => (!difficulty || p.difficulty === difficulty) && (!track || p.track === track),
      ),
    [problems, query, difficulty, track],
  );
  const present = DIFFICULTIES.filter((d) => problems.some((p) => p.difficulty === d));

  return (
    <>
      <Hero
        title="Practice"
        subtitle={
          browser
            ? "Written by your agent through WebMCP site tools. Solved by you, in the browser."
            : "Written by your agents through MCP. Solved by you."
        }
        aside={
          <ProgressCard
            loading={loading}
            unit="problems solved"
            done={problems.filter((p) => p.status === "passed").length}
            total={problems.length}
            bars={present.map((d) => {
              const all = problems.filter((p) => p.difficulty === d);
              return { key: d, label: d, tone: DIFFICULTY_TONE[d], all: all.length, done: all.filter((p) => p.status === "passed").length };
            })}
          />
        }
      />

      {notices}
      {errors.length > 0 && (
        <div className="soft-alert tone-fail">
          <CircleAlert size={16} strokeWidth={1.9} />
          <div className="soft-alert-body">
            <strong>
              {errors.length} problem file{errors.length > 1 ? "s" : ""} could not be loaded
            </strong>
            {errors.map((e) => (
              <details key={e.path}>
                <summary>{e.path}</summary>
                <pre>{e.error}</pre>
              </details>
            ))}
          </div>
          <IconButton icon={X} label="Dismiss" onClick={onDismissErrors} />
        </div>
      )}

      <Toolbar query={query} onQuery={setQuery} placeholder="Search problems, tags, environments">
        {present.map((d) => (
          <Chip
            key={d}
            tone={difficulty === d ? DIFFICULTY_TONE[d] : "neutral"}
            active={difficulty === d}
            onClick={() => setDifficulty(difficulty === d ? null : d)}
          >
            <span className="cap">{d}</span>
          </Chip>
        ))}
        {tracks.length > 0 && present.length > 0 && <span className="chip-sep" />}
        {tracks.map((t) => (
          <Chip key={t} tone={track === t ? "accent" : "neutral"} active={track === t} onClick={() => setTrack(track === t ? null : t)}>
            {t}
          </Chip>
        ))}
      </Toolbar>

      <div className="card list-card zebra">
        {loading && <RowSkeletons />}
        {filtered.map((p) => (
          <ProblemRow key={p.id} p={p} index={problems.indexOf(p)} />
        ))}
        {!loading && problems.length > 0 && filtered.length === 0 && (
          <Empty icon={Search}>No problems match these filters.</Empty>
        )}
        {!loading && problems.length === 0 && (
          <Empty icon={Inbox}>
            {browser ? (
              <>
                No problems yet. Ask your agent to create one with the <code>create_problem</code> site tool, or import a problem
                bundle.
              </>
            ) : (
              <>
                No problems yet. Ask an agent to create one through the leegen MCP server, or add a YAML file to{" "}
                <code>data/problems/</code>.
              </>
            )}
          </Empty>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ tutorials */

const tutorialDone = (t: TutorialSummary) => t.checked > 0 && t.passed >= t.checked;
const tutorialStatus = (t: TutorialSummary): ProblemSummary["status"] =>
  tutorialDone(t) ? "passed" : t.passed > 0 ? "attempted" : undefined;

function TutorialsView({ tutorials }: { tutorials: TutorialSummary[] | null }) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const loading = tutorials === null;
  const all = tutorials ?? [];
  const tags = useMemo(() => [...new Set(all.flatMap((t) => t.tags))].slice(0, 8), [all]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (t) =>
        (!tag || t.tags.includes(tag)) &&
        (!q || [t.title, t.id, t.summary, t.environment, ...t.tags].some((s) => s.toLowerCase().includes(q))),
    );
  }, [all, query, tag]);

  const finished = all.filter(tutorialDone).length;
  const checked = all.reduce((n, t) => n + t.checked, 0);
  const passed = all.reduce((n, t) => n + Math.min(t.passed, t.checked), 0);

  return (
    <>
      <Hero
        title="Tutorials"
        subtitle="Read a short step, edit the cell, run it. Hidden checks tell you when it is right."
        aside={
          <ProgressCard
            loading={loading}
            unit="tutorials finished"
            done={finished}
            total={all.length}
            bars={[{ key: "steps", label: "Steps", tone: "pass", all: checked, done: passed }]}
          />
        }
      />

      <Toolbar query={query} onQuery={setQuery} placeholder="Search tutorials, topics">
        {tags.map((t) => (
          <Chip key={t} tone={tag === t ? "accent" : "neutral"} active={tag === t} onClick={() => setTag(tag === t ? null : t)}>
            {t}
          </Chip>
        ))}
      </Toolbar>

      <div className="card list-card zebra">
        {loading && <RowSkeletons />}
        {filtered.map((t, i) => (
          <TutorialRow key={t.id} t={t} index={all.indexOf(t) < 0 ? i : all.indexOf(t)} />
        ))}
        {!loading && all.length > 0 && filtered.length === 0 && <Empty icon={Search}>No tutorials match.</Empty>}
        {!loading && all.length === 0 && (
          <Empty icon={Inbox}>
            No tutorials yet. Add a YAML file to <code>data/tutorials/</code> (see <code>docs/tutorials.md</code>).
          </Empty>
        )}
      </div>
    </>
  );
}

function TutorialRow({ t, index }: { t: TutorialSummary; index: number }) {
  const path = `/t/${t.id}`;
  return (
    <a
      href={appHref(path)}
      className="problem-row tutorial-row"
      onClick={(e) => {
        e.preventDefault();
        navigate(path);
      }}
    >
      <StatusIcon status={tutorialStatus(t)} />
      <span className="tr-body">
        <span className="pr-title">
          <span className="pr-index">{index + 1}.</span> {t.title}
        </span>
        {t.summary && <span className="tr-summary">{t.summary}</span>}
      </span>
      <span className="pr-meta">
        {t.tags.slice(0, 2).map((x) => (
          <Chip key={x}>{x}</Chip>
        ))}
      </span>
      <span className={cx("tr-progress tabular", tutorialDone(t) ? "tone-text-pass" : "muted")}>
        {t.checked > 0 ? `${Math.min(t.passed, t.checked)}/${t.checked}` : `${t.cells} cells`}
      </span>
    </a>
  );
}
