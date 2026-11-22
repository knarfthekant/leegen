// Lightweight, offline completions for commonly used Python standard-library types.
// This is deliberately a catalog, not a Python type checker.
import { maskPython } from "./pythonSymbols.ts";

export interface LibraryMember { name: string; detail: string; kind: "class" | "function" | "method" | "property" }
const member = (name: string, args: string, kind: LibraryMember["kind"] = "method"): LibraryMember => ({ name, detail: `${name}${args}`, kind });
const dict = [member("clear", "()"), member("copy", "()"), member("fromkeys", "(iterable, value=None)"), member("get", "(key, default=None)"), member("items", "()"), member("keys", "()"), member("pop", "(key, default=...)"), member("popitem", "()"), member("setdefault", "(key, default=None)"), member("update", "(other=(), **kwargs)"), member("values", "()")];
const types: Record<string, LibraryMember[]> = {
  "collections.defaultdict": [...dict, member("default_factory", "", "property")],
  "collections.Counter": [...dict, member("elements", "()"), member("most_common", "(n=None)"), member("subtract", "(iterable=(), **kwargs)"), member("total", "()")],
  "collections.deque": ["append(x)", "appendleft(x)", "clear()", "copy()", "count(x)", "extend(iterable)", "extendleft(iterable)", "index(x, start=0, stop=...)", "insert(i, x)", "pop()", "popleft()", "remove(value)", "reverse()", "rotate(n=1)"].map((s) => member(s.slice(0, s.indexOf("(")), s.slice(s.indexOf("(")))),
};
const modules: Record<string, LibraryMember[]> = {
  collections: [member("defaultdict", "(default_factory=None, /, ...) ", "class"), member("Counter", "(iterable=None, /, **kwargs)", "class"), member("deque", "(iterable=(), maxlen=None)", "class"), member("namedtuple", "(typename, field_names, *, rename=False, defaults=None, module=None)", "function"), member("ChainMap", "(*maps)", "class"), member("OrderedDict", "(...) ", "class")],
  heapq: ["heapify(x)", "heappush(heap, item)", "heappop(heap)", "heappushpop(heap, item)", "heapreplace(heap, item)", "nlargest(n, iterable, key=None)", "nsmallest(n, iterable, key=None)", "merge(*iterables, key=None, reverse=False)"].map((s) => member(s.slice(0, s.indexOf("(")), s.slice(s.indexOf("(")), "function")),
  itertools: ["accumulate", "chain", "combinations", "combinations_with_replacement", "count", "cycle", "groupby", "islice", "permutations", "product", "repeat", "starmap", "zip_longest"].map((s) => member(s, "(...) ", "function")),
  math: ["ceil", "floor", "sqrt", "gcd", "lcm", "factorial", "inf", "isfinite", "isinf", "isnan", "log", "pi", "sin", "cos"].map((s) => member(s, ["inf", "pi"].includes(s) ? "" : "(...) ", ["inf", "pi"].includes(s) ? "property" : "function")),
};

/** Resolve simple imports, aliases and constructor assignments before the cursor. */
export function libraryMembers(source: string, expression: string): LibraryMember[] | null {
  const code = maskPython(source).replace(/(from\s+[\w.]+\s+import\s*\()([^)]*)\)/g,
    (_match, start: string, body: string) => start + body.replace(/\n/g, " ") + ")");
  const bindings = new Map<string, string>();
  const instances = new Map<string, string>();
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    const from = /^from\s+([\w.]+)\s+import\s+(.+)/.exec(line);
    if (from) {
      for (const part of from[2].replace(/[()]/g, "").split(",")) {
        const m = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (m) bindings.set(m[2] ?? m[1], `${from[1]}.${m[1]}`);
      }
      continue;
    }
    const imp = /^import\s+(.+)/.exec(line);
    if (imp) {
      for (const part of imp[1].split(",")) {
        const m = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (m) bindings.set(m[2] ?? m[1].split(".")[0], m[2] ? m[1] : m[1].split(".")[0]);
      }
      continue;
    }
    const assign = /^(\w+)\s*(?::[^=]+)?=\s*([\w.]+)\s*\(/.exec(line);
    if (assign) {
      const parts = assign[2].split(".");
      const resolved = [bindings.get(parts[0]) ?? parts[0], ...parts.slice(1)].join(".");
      instances.set(assign[1], resolved);
    } else {
      const reassigned = /^(\w+)\s*(?::[^=]+)?=/.exec(line);
      if (reassigned) instances.delete(reassigned[1]);
    }
  }
  const parts = expression.split(".");
  const root = parts.shift()!;
  const resolved = [instances.get(root) ?? bindings.get(root) ?? root, ...parts].join(".");
  return types[resolved] ?? modules[resolved] ?? null;
}
