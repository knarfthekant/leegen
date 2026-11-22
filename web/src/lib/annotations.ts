// Review comments drawn onto Monaco editors: highlights, gutter marks, hover. Shared by the
// problem editor and the tutorial cells.

import { monaco } from "./monaco";
import type { Annotation } from "./api";

// --- annotations -------------------------------------------------------------------------------
// Each editor publishes its annotations here, keyed by model URI, so the hover provider (one for
// all models) and the click handler can find them. `range` reads the *tracked* decoration range,
// so it follows the user's edits instead of the position the annotation was created at.

export interface Entry {
  a: Annotation;
  range: () => monaco.Range;
  lane: monaco.editor.GlyphMarginLane;
  /** Clicking it focuses it somewhere (the Review panel); the hover says so. */
  focusable: boolean;
}

export const entriesByModel = new Map<string, Entry[]>();

/**
 * The exact characters an annotation covers. The server always sends columns; annotations saved
 * before that (or created without them) fall back to the text of the line(s) minus indentation.
 */
function resolveRange(a: Annotation, model: monaco.editor.ITextModel): monaco.Range {
  const last = model.getLineCount();
  const startLine = Math.min(Math.max(a.start_line ?? 1, 1), last);
  const endLine = Math.min(Math.max(a.end_line ?? startLine, startLine), last);
  const startCol = a.start_col ?? (model.getLineFirstNonWhitespaceColumn(startLine) || model.getLineMaxColumn(startLine));
  let endCol = a.end_col ?? (model.getLineLastNonWhitespaceColumn(endLine) || startCol);
  if (startLine === endLine) endCol = Math.max(endCol, startCol);
  return new monaco.Range(startLine, startCol, endLine, endCol);
}

/** Smaller ranges first, so the most specific comment comes first at a click or hover. */
function weight(r: monaco.Range) {
  return (r.endLineNumber - r.startLineNumber) * 10000 + (r.endColumn - r.startColumn);
}

export function entriesAt(uri: string, pos: monaco.IPosition): Entry[] {
  return (entriesByModel.get(uri) ?? [])
    .filter((e) => e.range().containsPosition(pos))
    .sort((x, y) => weight(x.range()) - weight(y.range()));
}

/** Each comment owns one gutter lane at its lines; comments that overlap in lines take other lanes. */
function assignLanes(items: { startLine: number; endLine: number }[]): monaco.editor.GlyphMarginLane[] {
  const lanes = [
    monaco.editor.GlyphMarginLane.Left,
    monaco.editor.GlyphMarginLane.Center,
    monaco.editor.GlyphMarginLane.Right,
  ];
  const taken: [number, number][][] = lanes.map(() => []);
  const order = items.map((_, i) => i).sort((x, y) => items[x].startLine - items[y].startLine || x - y);
  const out = new Array<monaco.editor.GlyphMarginLane>(items.length);
  for (const i of order) {
    const { startLine, endLine } = items[i];
    let lane = taken.findIndex((spans) => spans.every(([s, e]) => endLine < s || startLine > e));
    if (lane < 0) lane = lanes.length - 1; // more than three at once: the last lane is shared
    taken[lane].push([startLine, endLine]);
    out[i] = lanes[lane];
  }
  return out;
}

let hoverRegistered = false;
export function registerAnnotationHover() {
  if (hoverRegistered) return;
  hoverRegistered = true;
  monaco.languages.registerHoverProvider("*", {
    provideHover(model, position) {
      const hits = entriesAt(model.uri.toString(), position);
      if (!hits.length) return null;
      return {
        range: hits[0].range(),
        contents: hits.flatMap(({ a, focusable }) => [
          { value: `**${a.severity}** · ${a.author}\n\n${a.message}` },
          ...(focusable ? [{ value: "_Click to focus in Review_" }] : []),
        ]),
      };
    },
  });
}

export function severityColor(s: Annotation["severity"]): string {
  return { info: "#8a8a86", hint: "#5b7fd6", warning: "#d19a2a", error: "#d9534f", praise: "#3f9a63" }[s];
}

/**
 * Paint `mine` (one file's annotations) onto the editor behind `coll`: per comment one
 * translucent highlight layer (layers blend, so overlaps stay visible), then one gutter mark per
 * line: a dot for a single line, a connected bar for several. Also publishes them for hover/click.
 */
export function applyAnnotations(
  coll: monaco.editor.IEditorDecorationsCollection,
  model: monaco.editor.ITextModel,
  mine: Annotation[],
  selectedId: string | null,
  focusable = true,
) {
  const uri = model.uri.toString();
  const ranges = mine.map((a) => resolveRange(a, model));
  const lanes = assignLanes(ranges.map((r) => ({ startLine: r.startLineNumber, endLine: r.endLineNumber })));

  const items: monaco.editor.IModelDeltaDecoration[] = [];
  const slots: { entry: number; kind: "text" | "glyph" }[] = [];
  mine.forEach((a, i) => {
    const r = ranges[i];
    const sel = a.id === selectedId ? " lc-sel" : "";
    const sev = `lc-sev-${a.severity}`;
    items.push({
      range: r,
      options: {
        className: `lc-ann ${sev}${sel}`,
        overviewRuler: { color: severityColor(a.severity), position: monaco.editor.OverviewRulerLane.Right },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
    slots.push({ entry: i, kind: "text" });
    for (let line = r.startLineNumber; line <= r.endLineNumber; line++) {
      const part = r.startLineNumber === r.endLineNumber ? "dot" : line === r.startLineNumber ? "start" : line === r.endLineNumber ? "end" : "mid";
      items.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMargin: { position: lanes[i] },
          glyphMarginClassName: `lc-glyph lc-glyph-${part} ${sev}${sel}`,
          glyphMarginHoverMessage: { value: a.message },
        },
      });
      slots.push({ entry: i, kind: "glyph" });
    }
  });
  coll.set(items);
  const textIndex = new Map<number, number>();
  slots.forEach((s, k) => s.kind === "text" && textIndex.set(s.entry, k));
  entriesByModel.set(
    uri,
    mine.map((a, i) => ({
      a,
      lane: lanes[i],
      focusable,
      // the text layer's tracked range, which moves with the user's edits
      range: () => (coll.getRange(textIndex.get(i)!) ?? ranges[i]),
    })),
  );
}
