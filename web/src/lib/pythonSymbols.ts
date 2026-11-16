// A dependency-free Python scanner for the editor's completion, signature help and hover.
// It is intentionally shallow: it finds definitions, top-level names and imports, and does not
// try to understand types. Pure and testable outside the browser (see pythonSymbols.test.ts).

export type PySymbolKind = "function" | "method" | "class" | "variable" | "module";

export interface PySymbol {
  name: string;
  kind: PySymbolKind;
  /** File that defines it. */
  path: string;
  /** 1-based line of the def/class/assignment/import. */
  line: number;
  /** Leading whitespace of the definition line. */
  indent: number;
  /** defs only: top-level parameter text, trimmed. */
  params: string[];
  /** defs only: the text after "->", if any. */
  returns: string | null;
  signature: string;
  /** First non-empty docstring line, if any. */
  doc: string | null;
}

export interface PyFileParse {
  symbols: PySymbol[];
  truncated: boolean;
}

export interface PySymbolIndex {
  /** Current file first, then the rest in the order they were collected. */
  symbols: PySymbol[];
  byName: Map<string, PySymbol[]>;
}

export const MAX_SOURCE_CHARS = 256_000;
export const MAX_SYMBOLS = 400;
const MAX_SIGNATURE = 160;
const MAX_DOC = 160;

/** Blank strings and comments, preserving offsets and newlines. */
export function maskPython(source: string): string {
  const out = source.split("");
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "#") {
      while (i < source.length && source[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c !== '"' && c !== "'") {
      i++;
      continue;
    }
    const triple = source.startsWith(c.repeat(3), i);
    const quote = triple ? c.repeat(3) : c;
    for (let k = 0; k < quote.length; k++) out[i + k] = " ";
    i += quote.length;
    while (i < source.length) {
      if (source[i] === "\\") {
        out[i] = " ";
        if (i + 1 < source.length && source[i + 1] !== "\n") out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (source.startsWith(quote, i)) {
        for (let k = 0; k < quote.length; k++) out[i + k] = " ";
        i += quote.length;
        break;
      }
      if (!triple && source[i] === "\n") break;   // unterminated single-line string
      if (source[i] !== "\n") out[i] = " ";
      i++;
    }
  }
  return out.join("");
}

/** Split at depth-0 separators, ignoring brackets and commas inside strings. */
export function splitTopLevel(text: string, sep = ","): string[] {
  const masked = maskPython(text);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

function matchingParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function docLine(lines: string[], header: number, indent: number): string | null {
  let j = header + 1;
  while (j < lines.length && !lines[j].trim()) j++;
  if (j >= lines.length) return null;
  const text = lines[j];
  const lead = text.length - text.trimStart().length;
  if (lead <= indent) return null;
  const trimmed = text.trim();
  const m = /^[rRbBuUfF]{0,2}("""|'''|"|')/.exec(trimmed);
  if (!m) return null;
  const quote = m[1];
  const rest = trimmed.slice(m[0].length);
  if (quote.length === 1) {
    const end = rest.indexOf(quote);
    const body = (end >= 0 ? rest.slice(0, end) : rest).trim();
    return body ? body.slice(0, MAX_DOC) : null;
  }
  const end = rest.indexOf(quote);
  if (end >= 0) {
    const body = rest.slice(0, end).trim();
    return body ? body.slice(0, MAX_DOC) : null;
  }
  const first = rest.trim();
  if (first) return first.slice(0, MAX_DOC);
  for (let k = j + 1; k < lines.length; k++) {
    const line = lines[k].trim();
    if (line.startsWith(quote)) return null;
    if (line) return line.slice(0, MAX_DOC);
  }
  return null;
}

export function parsePythonFile(path: string, source: string): PyFileParse {
  const truncated = source.length > MAX_SOURCE_CHARS;
  const src = truncated
    ? source.slice(0, Math.max(0, source.lastIndexOf("\n", MAX_SOURCE_CHARS)))
    : source;
  const masked = maskPython(src);
  const lines = src.split("\n");
  const maskedLines = masked.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  const symbols: PySymbol[] = [];
  const stack: { indent: number; kind: "class" | "function" }[] = [];
  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS; i++) {
    const line = maskedLines[i];
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trimStart();
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();

    const def = /^(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    if (def) {
      const open = offsets[i] + (line.length - trimmed.length) + trimmed.indexOf("(");
      const close = matchingParen(masked, open);
      if (close < 0) continue;
      const params = splitTopLevel(src.slice(open + 1, close));
      let colon = -1;
      let depth = 0;
      for (let k = close + 1; k < Math.min(masked.length, close + 2000); k++) {
        const c = masked[k];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
        else if (c === ":" && depth === 0) {
          colon = k;
          break;
        }
      }
      const headerStart = offsets[i] + (line.length - trimmed.length);
      const head = src.slice(headerStart, colon >= 0 ? colon : close + 1);
      const headerLine = colon >= 0 ? src.slice(0, colon).split("\n").length - 1 : i;
      const arrow = head.lastIndexOf("->");
      const returns = arrow >= 0 ? head.slice(arrow + 2).trim().slice(0, MAX_SIGNATURE) || null : null;
      const isMethod = stack.length > 0 && stack[stack.length - 1].kind === "class";
      const prefix = def[1] ? "async def" : "def";
      symbols.push({
        name: def[2],
        kind: isMethod ? "method" : "function",
        path,
        line: i + 1,
        indent,
        params,
        returns,
        signature: `${prefix} ${def[2]}(${params.join(", ")})${returns ? ` -> ${returns}` : ""}`
          .slice(0, MAX_SIGNATURE),
        doc: docLine(lines, headerLine, indent),
      });
      stack.push({ indent, kind: "function" });
      continue;
    }

    const cls = /^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/.exec(trimmed);
    if (cls) {
      const bases = cls[2]?.trim();
      symbols.push({
        name: cls[1],
        kind: "class",
        path,
        line: i + 1,
        indent,
        params: [],
        returns: null,
        signature: bases ? `class ${cls[1]}(${bases})` : `class ${cls[1]}`,
        doc: docLine(lines, i, indent),
      });
      stack.push({ indent, kind: "class" });
      continue;
    }

    if (indent > 0) continue;
    const fromImport = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(trimmed);
    if (fromImport) {
      const module = fromImport[1];
      for (const part of splitTopLevel(fromImport[2])) {
        const name = (part.split(/\s+as\s+/).pop() ?? "").trim();
        if (/^[A-Za-z_]\w*$/.test(name)) {
          symbols.push({
            name, kind: "module", path, line: i + 1, indent, params: [], returns: null,
            signature: `from ${module} import ${part.trim()}`.slice(0, MAX_SIGNATURE), doc: null,
          });
        }
      }
      continue;
    }
    const imp = /^import\s+(.+)$/.exec(trimmed);
    if (imp) {
      for (const part of splitTopLevel(imp[1])) {
        const name = (part.split(/\s+as\s+/).pop() ?? "").split(".")[0].trim();
        if (/^[A-Za-z_]\w*$/.test(name)) {
          symbols.push({
            name, kind: "module", path, line: i + 1, indent, params: [], returns: null,
            signature: `import ${part.trim()}`.slice(0, MAX_SIGNATURE), doc: null,
          });
        }
      }
      continue;
    }
    const assign = /^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/.exec(trimmed);
    if (assign) {
      symbols.push({
        name: assign[1], kind: "variable", path, line: i + 1, indent, params: [], returns: null,
        signature: lines[i].trim().slice(0, MAX_SIGNATURE), doc: null,
      });
    }
  }
  return { symbols, truncated };
}

/** The call the cursor is inside: `merge_ranges(a, |)` -> {callee, activeParameter: 1}. */
export function findCallContext(
  source: string,
  offset: number,
): { callee: string; activeParameter: number } | null {
  const masked = maskPython(source.slice(0, Math.max(0, Math.min(offset, source.length))));
  const stack: { ch: string; at: number }[] = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") stack.push({ ch: c, at: i });
    else if (c === ")" || c === "]" || c === "}") stack.pop();
  }
  let call = -1;
  for (let s = stack.length - 1; s >= 0; s--) {
    if (stack[s].ch === "(") {
      call = stack[s].at;
      break;
    }
  }
  if (call < 0) return null;
  let j = call - 1;
  while (j >= 0 && /\s/.test(masked[j])) j--;
  const end = j;
  while (j >= 0 && /[A-Za-z0-9_.]/.test(masked[j])) j--;
  const callee = masked.slice(j + 1, end + 1).split(".").pop() ?? "";
  if (!callee || /^\d/.test(callee)) return null;
  const before = masked.slice(Math.max(0, j - 20), j + 1);
  if (/(?:async\s+)?def\s+$/.test(before) || /class\s+$/.test(before)) return null;
  let depth = 0;
  let activeParameter = 0;
  for (const c of masked.slice(call + 1)) {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) activeParameter++;
  }
  return { callee, activeParameter };
}

export function buildSymbolIndex(
  files: readonly { path: string; symbols: PySymbol[] }[],
  currentPath: string,
): PySymbolIndex {
  const ordered = [...files];
  const at = ordered.findIndex((f) => f.path === currentPath);
  if (at > 0) ordered.unshift(ordered.splice(at, 1)[0]);
  const symbols = ordered.flatMap((f) => f.symbols);
  const byName = new Map<string, PySymbol[]>();
  for (const sym of symbols) {
    const list = byName.get(sym.name);
    if (list) list.push(sym);
    else byName.set(sym.name, [sym]);
  }
  return { symbols, byName };
}
