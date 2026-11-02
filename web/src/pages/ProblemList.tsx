import { CircleAlert, Inbox, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Brand, ConnectionDot, ThemeToggle } from "../components/Chrome";
import { filterProblems, ProblemRow } from "../components/ProblemRow";
import { Chip, DIFFICULTY_TONE, IconButton, Skeleton } from "../components/ui";
import { getBackend, useBackendEvents } from "../backend";
import { type Difficulty, type ProblemSummary } from "../lib/api";
import { navigate } from "../lib/router";

const DIFFICULTIES: Difficulty[] = ["intro", "easy", "medium", "hard"];

export function ProblemList() {
  const [problems, setProblems] = useState<ProblemSummary[]>([]);
  const [errors, setErrors] = useState<{ path: string; error: string }[]>([]);
  const [errorsHidden, setErrorsHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [track, setTrack] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  const tracks = useMemo(() => [...new Set(problems.map((p) => p.track).filter((t): t is string => !!t))], [problems]);
  const filtered = useMemo(
    () =>
      filterProblems(problems, query).filter(
        (p) => (!difficulty || p.difficulty === difficulty) && (!track || p.track === track),
      ),
    [problems, query, difficulty, track],
  );

  return (
    <div className="list-page">
      <header className="topbar">
        <Brand />
        <div className="spacer" />
        <ConnectionDot />
        <ThemeToggle />
      </header>
      <main className="list-main">
        <div className="list-hero">
          <div>
            <h1 className="page-title">Problems</h1>
            <p className="muted">
              {browser
                ? "Written by your agent through WebMCP site tools. Solved by you, in the browser."
                : "Written by your agents through MCP. Solved by you."}
            </p>
          </div>
          <Progress problems={problems} loading={loading} />
        </div>

        {errors.length > 0 && !errorsHidden && (
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
            <IconButton icon={X} label="Dismiss" onClick={() => setErrorsHidden(true)} />
          </div>
        )}

        <div className="list-toolbar">
          <label className="search-field">
            <Search size={15} strokeWidth={1.8} />
            <input placeholder="Search problems, tags, environments" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="chip-row">
            {DIFFICULTIES.filter((d) => problems.some((p) => p.difficulty === d)).map((d) => (
              <Chip
                key={d}
                tone={difficulty === d ? DIFFICULTY_TONE[d] : "neutral"}
                active={difficulty === d}
                onClick={() => setDifficulty(difficulty === d ? null : d)}
              >
                <span className="cap">{d}</span>
              </Chip>
            ))}
            {tracks.length > 0 && <span className="chip-sep" />}
            {tracks.map((t) => (
              <Chip key={t} tone={track === t ? "accent" : "neutral"} active={track === t} onClick={() => setTrack(track === t ? null : t)}>
                {t}
              </Chip>
            ))}
          </div>
        </div>

        <div className="card list-card zebra">
          {loading &&
            Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="problem-row">
                <Skeleton w={16} h={16} r={8} />
                <Skeleton w={`${40 + ((i * 17) % 30)}%`} />
              </div>
            ))}
          {filtered.map((p) => (
            <ProblemRow key={p.id} p={p} index={problems.indexOf(p)} />
          ))}
          {!loading && problems.length > 0 && filtered.length === 0 && (
            <div className="empty">
              <Search size={20} strokeWidth={1.6} />
              <span>No problems match these filters.</span>
            </div>
          )}
          {!loading && problems.length === 0 && (
            <div className="empty">
              <Inbox size={22} strokeWidth={1.6} />
              {browser ? (
                <span>
                  No problems yet. Ask your agent to create one with the <code>create_problem</code> site tool, or import a
                  problem bundle.
                </span>
              ) : (
                <span>
                  No problems yet. Ask an agent to create one through the leetclaude MCP server, or add a YAML file to{" "}
                  <code>problems/</code>.
                </span>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Progress({ problems, loading }: { problems: ProblemSummary[]; loading: boolean }) {
  const solved = problems.filter((p) => p.status === "passed").length;
  const total = problems.length;
  const pct = total ? solved / total : 0;
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="card progress-card">
      <div className="ring">
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <circle cx="32" cy="32" r={r} className="ring-track" />
          <circle cx="32" cy="32" r={r} className="ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
        </svg>
        <div className="ring-label tabular">
          <strong>{loading ? "–" : solved}</strong>
          <span>/{total}</span>
        </div>
      </div>
      <div className="bars">
        {DIFFICULTIES.filter((d) => problems.some((p) => p.difficulty === d)).map((d) => {
          const all = problems.filter((p) => p.difficulty === d);
          const done = all.filter((p) => p.status === "passed").length;
          return (
            <div key={d} className="bar-row">
              <span className={`cap tone-text-${DIFFICULTY_TONE[d]}`}>{d}</span>
              <span className={`bar tone-${DIFFICULTY_TONE[d]}`}>
                <span style={{ width: `${(done / all.length) * 100}%` }} />
              </span>
              <span className="tabular muted small">
                {done}/{all.length}
              </span>
            </div>
          );
        })}
        {!loading && total === 0 && <span className="muted small">Nothing solved yet</span>}
      </div>
    </div>
  );
}
