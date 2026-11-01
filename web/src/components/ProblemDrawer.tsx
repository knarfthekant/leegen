import { ListTree, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProblemSummary } from "../lib/api";
import { navigate } from "../lib/router";
import { filterProblems, ProblemRow } from "./ProblemRow";
import { IconButton } from "./ui";

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
  const input = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => filterProblems(problems, query), [problems, query]);
  const solved = problems.filter((p) => p.status === "passed").length;

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
      <aside className="drawer" role="dialog" aria-label="Problem list">
        <div className="drawer-head">
          <button
            className="drawer-title"
            onClick={() => {
              onClose();
              navigate("/");
            }}
            title="Open the full problem list"
          >
            <ListTree size={16} strokeWidth={1.8} />
            Problem List
          </button>
          <span className="muted small tabular">
            {solved}/{problems.length} solved
          </span>
          <div className="spacer" />
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <label className="search-field">
          <Search size={15} strokeWidth={1.8} />
          <input
            ref={input}
            placeholder="Search problems"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            tabIndex={open ? 0 : -1}
          />
        </label>
        <div className="drawer-list zebra">
          {filtered.map((p) => (
            <ProblemRow
              key={p.id}
              p={p}
              index={problems.indexOf(p)}
              compact
              current={p.id === currentId}
              onOpen={onClose}
            />
          ))}
          {filtered.length === 0 && <p className="muted small drawer-empty">No matching problems.</p>}
        </div>
      </aside>
    </div>
  );
}
