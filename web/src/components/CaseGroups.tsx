import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { SectionGroup } from "../lib/sections";
import { Markdown } from "./Markdown";

/**
 * Pills grouped under collapsible section headers (title + description). When the problem has
 * no sections this renders a plain pill row, like before.
 */
export function CaseGroups<T>({
  groups,
  sectioned,
  render,
  trailing,
}: {
  groups: SectionGroup<T>[];
  /** false = the problem declares no sections: no headers at all */
  sectioned: boolean;
  render: (item: T) => ReactNode;
  /** shown after the last pill, e.g. the add-case button */
  trailing?: ReactNode;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!sectioned)
    return (
      <div className="case-tabs">
        {groups.flatMap((g) => g.items).map(render)}
        {trailing}
      </div>
    );

  const toggle = (id: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="case-groups">
      {groups.map((g, gi) => {
        const id = g.section?.id ?? "__other";
        const open = !closed.has(id);
        const Chevron = open ? ChevronDown : ChevronRight;
        const last = gi === groups.length - 1;
        return (
          <div className="case-group" key={id}>
            <button className="group-head" aria-expanded={open} onClick={() => toggle(id)}>
              <Chevron size={14} strokeWidth={2} />
              <span className="group-title">{g.section?.title ?? "Other"}</span>
              <span className="group-count tabular">{g.items.length}</span>
            </button>
            {open && g.section?.description && (
              <div className="group-desc muted">
                <Markdown source={g.section.description} />
              </div>
            )}
            {open && (
              <div className="case-tabs">
                {g.items.map(render)}
                {last && trailing}
              </div>
            )}
          </div>
        );
      })}
      {/* keep the add button reachable when the last group is collapsed */}
      {groups.length > 0 && closed.has(groups[groups.length - 1].section?.id ?? "__other") && (
        <div className="case-tabs">{trailing}</div>
      )}
    </div>
  );
}
