import { useEffect, useMemo, useState } from "react";
import { api, type ProblemSummary } from "../lib/api";
import { useServerEvents } from "../lib/events";
import { navigate } from "../lib/router";

export function ProblemList() {
  const [problems, setProblems] = useState<ProblemSummary[]>([]);
  const [errors, setErrors] = useState<{ path: string; error: string }[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const load = () =>
    api.problems().then((r) => {
      setProblems(r.problems);
      setErrors(r.errors);
      setLoading(false);
    });
  useEffect(() => {
    load();
  }, []);
  useServerEvents((e) => {
    if (e.type === "problems_changed" || e.type === "run_finished") load();
    if (e.type === "navigate" && typeof e.problem_id === "string") navigate(`/p/${e.problem_id}`);
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return problems;
    return problems.filter((p) =>
      [p.title, p.id, p.track ?? "", p.environment, ...p.tags].some((s) => s.toLowerCase().includes(q)),
    );
  }, [problems, query]);

  return (
    <div className="list-page">
      <header className="topbar">
        <span className="brand">leetclaude</span>
        <div className="spacer" />
        <input className="search" placeholder="Filter problems" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>
      <main className="list-main">
        {errors.length > 0 && (
          <div className="error-block">
            {errors.map((e) => (
              <div key={e.path}>
                <strong>{e.path}</strong>
                <pre>{e.error}</pre>
              </div>
            ))}
          </div>
        )}
        <table className="problem-table">
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              <th>Title</th>
              <th>Track</th>
              <th>Difficulty</th>
              <th>Environment</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id} onClick={() => navigate(`/p/${p.id}`)}>
                <td className="status-cell">
                  {p.status === "passed" ? <span className="check" title="Passed">✓</span> : p.status === "attempted" ? <span className="attempt" title="Attempted">○</span> : null}
                </td>
                <td>
                  <a
                    href={`/p/${p.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/p/${p.id}`);
                    }}
                  >
                    {p.title}
                  </a>
                </td>
                <td className="muted">{p.track ?? ""}</td>
                <td className={`diff diff-${p.difficulty}`}>{p.difficulty}</td>
                <td className="muted">
                  {p.environment}
                  {p.requires.some((r) => r !== "cpu") && <span className="tag">{p.requires.filter((r) => r !== "cpu").join(", ")}</span>}
                </td>
                <td className="muted small">{p.tags.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && problems.length === 0 && (
          <p className="muted">
            No problems yet. Ask an agent to create one through the leetclaude MCP server, or add a YAML file to{" "}
            <code>problems/</code>.
          </p>
        )}
      </main>
    </div>
  );
}
