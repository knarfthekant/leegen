import type { PublicSection } from "./api";

export interface SectionGroup<T> {
  /** null for items outside any section. */
  section: PublicSection | null;
  items: T[];
}

/**
 * Group items under the problem's sections, in section order. Items without a (known) section
 * come last. With no sections declared everything stays in one headerless group, which is how
 * problems looked before sections existed. Items keep their original order inside a group.
 */
export function groupBySection<T extends { section?: string | null }>(
  items: T[],
  sections: PublicSection[],
  titleFor?: (id: string) => PublicSection,
): SectionGroup<T>[] {
  const known = new Map(sections.map((s) => [s.id, s]));
  const groups = new Map<string, SectionGroup<T>>(
    sections.map((s) => [s.id, { section: s, items: [] }]),
  );
  const loose: T[] = [];
  for (const it of items) {
    const id = it.section;
    if (id && known.has(id)) groups.get(id)!.items.push(it);
    else if (id && titleFor) {
      // e.g. pytest class names: a section that the problem does not declare
      if (!groups.has(id)) groups.set(id, { section: titleFor(id), items: [] });
      groups.get(id)!.items.push(it);
    } else loose.push(it);
  }
  const out = [...groups.values()].filter((g) => g.items.length > 0);
  if (loose.length) out.push({ section: null, items: loose });
  return out;
}

/** A section built from a bare id (pytest class names have no title or description). */
export const bareSection = (id: string): PublicSection => ({ id, title: id, description: null });
