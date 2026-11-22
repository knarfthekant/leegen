import { EyeOff } from "lucide-react";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { SectionGroup } from "../lib/sections";
import { Markdown } from "./Markdown";
import { cx } from "./ui";

export type SegmentState = "pass" | "fail" | "neutral";

export interface CaseSegment {
  /** Global position, shown as the test number (index + 1). */
  index: number;
  key: string;
}

/**
 * One pill-shaped bar per group: equal segments, rounded at both ends, and one highlight that
 * slides to the selected segment. In results a segment is tinted by its outcome instead of
 * carrying a dot, and a hidden test carries an eye.
 */
function SegmentBar<T extends CaseSegment>({
  items,
  selected,
  onSelect,
  state,
  hidden,
  tinted,
  numbers,
}: {
  items: T[];
  selected: number;
  onSelect: (index: number) => void;
  state?: (item: T) => SegmentState;
  hidden?: (item: T) => boolean;
  tinted: boolean;
  /** Display number per item index: segments are numbered in the order the groups show them. */
  numbers: Map<number, number>;
}) {
  const at = items.findIndex((i) => i.index === selected);
  return (
    <div
      className={cx("seg-bar", tinted && "tinted", at < 0 && "none")}
      role="tablist"
      style={{ "--n": items.length, "--i": Math.max(at, 0) } as CSSProperties}
    >
      <span className={cx("seg-thumb", at === 0 && "first", at === items.length - 1 && "last")} aria-hidden />
      {items.map((item) => {
        const st = state?.(item) ?? "neutral";
        const eye = hidden?.(item);
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={item.index === selected}
            aria-label={[`Test ${numbers.get(item.index)}`, eye && "hidden", state && (st === "pass" ? "passed" : "failed")]
              .filter(Boolean).join(", ")}
            className={cx("seg", `seg-${st}`, item.index === selected && "active")}
            onClick={() => onSelect(item.index)}
          >
            <span className="tabular">{numbers.get(item.index)}</span>
            {eye && <EyeOff size={11} strokeWidth={2} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

/** The selected case's detail; it scrolls into view when the selection moves, so it is never below the fold. */
function Detail({ id, children }: { id: string; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    el.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [id]);
  return (
    <div className="tg-detail" ref={el}>
      {children}
    </div>
  );
}

/**
 * Test cases (or results) in their groups. Each group shows its title, its one description, a
 * segmented bar and, when the selected case is in it, the case's detail directly underneath, so
 * nothing needs scrolling. Groups are always open.
 */
export function TestGroups<T extends CaseSegment>({
  groups,
  selected,
  onSelect,
  detail,
  state,
  hidden,
  action,
}: {
  groups: SectionGroup<T>[];
  selected: number;
  onSelect: (index: number) => void;
  detail: (item: T, number: number) => ReactNode;
  /** Result tint per segment; omit for the Testcase tab, where segments stay neutral. */
  state?: (item: T) => SegmentState;
  hidden?: (item: T) => boolean;
  /** Per-group control after the bar, e.g. add a case to this group. */
  action?: (group: SectionGroup<T>) => ReactNode;
}) {
  const numbers = new Map<number, number>();
  for (const g of groups) for (const item of g.items) numbers.set(item.index, numbers.size + 1);
  return (
    <div className="tg-list">
      {groups.map((g) => {
        const current = g.items.find((i) => i.index === selected);
        return (
          <section className="tg" key={g.section?.id ?? "__ungrouped"}>
            {g.section && (
              <header className="tg-head">
                <h3 className="tg-title">{g.section.title}</h3>
                <span className="tg-count tabular">
                  {state ? `${g.items.filter((i) => state(i) === "pass").length}/${g.items.length}` : g.items.length}
                </span>
              </header>
            )}
            {g.section?.description && (
              <div className="tg-desc">
                <Markdown source={g.section.description} />
              </div>
            )}
            <div className="tg-row">
              <SegmentBar items={g.items} selected={selected} onSelect={onSelect} state={state} hidden={hidden} tinted={!!state} numbers={numbers} />
              {action?.(g)}
            </div>
            {current && (
              <Detail id={current.key}>{detail(current, numbers.get(current.index)!)}</Detail>
            )}
          </section>
        );
      })}
    </div>
  );
}
