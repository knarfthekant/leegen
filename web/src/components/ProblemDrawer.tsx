import { ListTree, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ProblemSummary, TutorialSummary } from "../lib/api";
import { navigate } from "../lib/router";
import { filterProblems, ProblemRow } from "./ProblemRow";
import { filterTutorials, tutorialDone, TutorialRow } from "./TutorialRow";
import { IconButton } from "./ui";

/** The slide-over shell both lists share: a title that opens the full list, a count, search. */
function ListDrawer({
  open,
  onClose,
  title,
  homePath,
  count,
  placeholder,
  query,
  onQuery,
  empty,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  homePath: string;
  count: string;
  placeholder: string;
  query: string;
  onQuery: (q: string) => void;
  empty: boolean;
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => input.current?.focus(), 160);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className={"drawer-root" + (open ? " open" : "")} aria-hidden={!open}>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title}>
        <div className="drawer-head">
          <button
            className="drawer-title"
            onClick={() => {
              onClose();
              navigate(homePath);
            }}
            title={`Open the full ${title.toLowerCase()}`}
          >
            <ListTree size={16} strokeWidth={1.8} />
            {title}
          </button>
          <span className="muted small tabular">{count}</span>
          <div className="spacer" />
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <label className="search-field">
          <Search size={15} strokeWidth={1.8} />
          <input
            ref={input}
            placeholder={placeholder}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            tabIndex={open ? 0 : -1}
          />
        </label>
        <div className="drawer-list zebra">
          {children}
          {empty && <p className="muted small drawer-empty">No matching {placeholder.replace("Search ", "")}.</p>}
        </div>
      </aside>
    </div>
  );
}

/** Slide-over problem list (LeetCode's "Problem List" drawer). */
export function ProblemDrawer({
  open,
  onClose,
  problems,
  currentId,
}: {
  open: boolean;
  onClose: () => void;
  problems: ProblemSummary[];
  currentId: string;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterProblems(problems, query), [problems, query]);
  const solved = problems.filter((p) => p.status === "passed").length;

  return (
    <ListDrawer
      open={open}
      onClose={onClose}
      title="Problem List"
      homePath="/"
      count={`${solved}/${problems.length} solved`}
      placeholder="Search problems"
      query={query}
      onQuery={setQuery}
      empty={filtered.length === 0}
    >
      {filtered.map((p) => (
        <ProblemRow key={p.id} p={p} index={problems.indexOf(p)} compact current={p.id === currentId} onOpen={onClose} />
      ))}
    </ListDrawer>
  );
}

/** The same drawer for tutorials. Its title opens the Tutorials page. */
export function TutorialDrawer({
  open,
  onClose,
  tutorials,
  currentId,
}: {
  open: boolean;
  onClose: () => void;
  tutorials: TutorialSummary[];
  currentId: string;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterTutorials(tutorials, query), [tutorials, query]);
  const finished = tutorials.filter(tutorialDone).length;

  return (
    <ListDrawer
      open={open}
      onClose={onClose}
      title="Tutorial List"
      homePath="/?view=tutorials"
      count={`${finished}/${tutorials.length} finished`}
      placeholder="Search tutorials"
      query={query}
      onQuery={setQuery}
      empty={filtered.length === 0}
    >
      {filtered.map((t) => (
        <TutorialRow key={t.id} t={t} index={tutorials.indexOf(t)} compact current={t.id === currentId} onOpen={onClose} />
      ))}
    </ListDrawer>
  );
}
