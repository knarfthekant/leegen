import assert from "node:assert/strict";
import { test } from "node:test";
import { libraryMembers } from "./pythonLibraries.ts";
import { parsePythonFile } from "./pythonSymbols.ts";

const names = (source: string, receiver: string) => libraryMembers(source, receiver)?.map((m) => m.name);

test("offers imported collections and methods on constructed instances", () => {
  const source = "from collections import defaultdict as dd, Counter\ngroups = dd(list)\ncounts = Counter()\n";
  assert.ok(names(source, "groups")?.includes("default_factory"));
  assert.ok(names(source, "groups")?.includes("items"));
  assert.ok(names(source, "counts")?.includes("most_common"));
  assert.equal(names(source + "groups = 3\n", "groups"), undefined);
});

test("resolves module aliases and multiline imports inside functions", () => {
  const source = "import collections as c\ndef f():\n    from collections import (\n        defaultdict as dd,\n        deque,\n    )\n    queue = deque()\n";
  assert.ok(names(source, "c")?.includes("defaultdict"));
  assert.ok(names(source, "c.defaultdict")?.includes("get"));
  assert.ok(names(source, "queue")?.includes("popleft"));
  const symbols = parsePythonFile("solution.py", source).symbols;
  assert.ok(symbols.some((s) => s.name === "dd" && s.line === 3));
  assert.ok(symbols.some((s) => s.name === "deque"));
});

test("offers heapq functions and ignores imports in comments and strings", () => {
  assert.ok(names("import heapq as h\n", "h")?.includes("heappush"));
  assert.equal(libraryMembers("# import heapq as h\n", "h"), null);
  assert.equal(libraryMembers('"import heapq as h"\n', "h"), null);
});
