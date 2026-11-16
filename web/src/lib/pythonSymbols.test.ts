/// <reference types="node" />
// Unit tests for the Python scanner behind editor completions/signature help/hover.
//   node --test src/lib/        (npm test)

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SYMBOLS,
  buildSymbolIndex,
  findCallContext,
  maskPython,
  parsePythonFile,
  splitTopLevel,
} from "./pythonSymbols.ts";

const MERGED = `def merge_ranges(
    bookings: list[list[int]],
    *,
    key=lambda x: (x[0], x[1]),
) -> list[list[int]]:
    """Merge ranges."""
    return bookings
`;

test("parses multi-line signatures, lambdas and docstrings", () => {
  const { symbols } = parsePythonFile("solution.py", MERGED);
  const fn = symbols.find((s) => s.name === "merge_ranges");
  assert.ok(fn);
  assert.equal(fn.kind, "function");
  assert.deepEqual(fn.params, ["bookings: list[list[int]]", "*", "key=lambda x: (x[0], x[1])"]);
  assert.equal(fn.returns, "list[list[int]]");
  assert.equal(fn.doc, "Merge ranges.");
  assert.equal(
    fn.signature,
    "def merge_ranges(bookings: list[list[int]], *, key=lambda x: (x[0], x[1])) -> list[list[int]]",
  );
});

test("classes, methods and docstrings group correctly", () => {
  const source = `"""Module docstring."""

class LRUCache:
    """Least-recently-used cache."""

    def __init__(self, capacity: int = 2):
        self.capacity = capacity

    def get(self, key):
        """Return -1 when missing."""
        return -1
`;
  const { symbols } = parsePythonFile("solution.py", source);
  const cls = symbols.find((s) => s.name === "LRUCache");
  assert.ok(cls);
  assert.equal(cls.kind, "class");
  assert.equal(cls.doc, "Least-recently-used cache.");
  const get = symbols.find((s) => s.name === "get");
  assert.ok(get);
  assert.equal(get.kind, "method");
  assert.equal(get.doc, "Return -1 when missing.");
});

test("strings and comments do not create symbols", () => {
  const source = `"""def fake():
    pass
"""
# def commented():
real = 1
`;
  const { symbols } = parsePythonFile("solution.py", source);
  assert.deepEqual(symbols.map((s) => s.name), ["real"]);
});

test("top-level assignments and imports are indexed; locals are not", () => {
  const source = `import os, sys as system
from collections import defaultdict, Counter as C
LIMIT = 10

def f():
    inner = 1
`;
  const { symbols } = parsePythonFile("solution.py", source);
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes("os") && names.includes("system"));
  assert.ok(names.includes("defaultdict") && names.includes("C"));
  assert.ok(names.includes("LIMIT"));
  assert.ok(!names.includes("inner"));
});

test("findCallContext tracks nested calls, strings and def headers", () => {
  const cases: [string, string, { callee: string; activeParameter: number } | null][] = [
    ["merge_ranges(", "merge_ranges(", { callee: "merge_ranges", activeParameter: 0 }],
    ["x = merge_ranges(a, ", "x = merge_ranges(a, ", { callee: "merge_ranges", activeParameter: 1 }],
    ["foo(bar(1, 2), ", "foo(bar(1, 2), ", { callee: "foo", activeParameter: 1 }],
    ['print("a, b", ', 'print("a, b", ', { callee: "print", activeParameter: 1 }],
    ["obj.method(1, ", "obj.method(1, ", { callee: "method", activeParameter: 1 }],
    ["def f(", "def f(", null],
    ["foo(a)", "foo(a)1", null],
  ];
  for (const [source, prefix, expected] of cases) {
    assert.deepEqual(findCallContext(source, prefix.length), expected, source);
  }
});

test("splitTopLevel ignores separators inside brackets and strings", () => {
  assert.deepEqual(splitTopLevel("a, dict[str, int], 'x,y'"), ["a", "dict[str, int]", "'x,y'"]);
  assert.deepEqual(splitTopLevel(""), []);
});

test("buildSymbolIndex puts the current file first", () => {
  const alpha = parsePythonFile("solution.py", "def alpha():\n    pass\n").symbols;
  const beta = parsePythonFile("helpers.py", "def beta():\n    pass\n").symbols;
  const index = buildSymbolIndex(
    [{ path: "helpers.py", symbols: beta }, { path: "solution.py", symbols: alpha }],
    "solution.py",
  );
  assert.deepEqual(index.symbols.map((s) => s.name), ["alpha", "beta"]);
  assert.equal(index.byName.get("beta")?.length, 1);
});

test("maskPython preserves offsets and blanks strings/comments", () => {
  const source = "x = 'a,b'  # def no()\ny = 2\n";
  const masked = maskPython(source);
  assert.equal(masked.length, source.length);
  assert.ok(!masked.includes("def no"));
  assert.equal(masked.split("\n").length, source.split("\n").length);
});

test("large sources are truncated and symbol counts are capped", () => {
  const source = "x = 1\n".repeat(50_000); // 300 KB
  const parsed = parsePythonFile("solution.py", source);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.symbols.length <= MAX_SYMBOLS);
});
