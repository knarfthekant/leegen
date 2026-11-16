// Small Python catalog for editor suggestions. Kept deliberately compact: this is a training
// tool, not an encyclopedia. No Monaco import, so it can be unit-tested in Node.

export interface BuiltinSpec {
  name: string;
  kind: "function" | "class";
  detail: string;
}

export interface SnippetSpec {
  label: string;
  description: string;
  insertText: string;
}

export const PY_KEYWORDS: readonly string[] = [
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "continue",
  "del", "elif", "else", "except", "finally", "from", "global", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "while", "yield",
];

export const PY_BUILTINS: readonly BuiltinSpec[] = [
  { name: "abs", kind: "function", detail: "abs(x)" },
  { name: "all", kind: "function", detail: "all(iterable)" },
  { name: "any", kind: "function", detail: "any(iterable)" },
  { name: "bool", kind: "class", detail: "bool(x)" },
  { name: "chr", kind: "function", detail: "chr(i)" },
  { name: "dict", kind: "class", detail: "dict(...)" },
  { name: "enumerate", kind: "function", detail: "enumerate(iterable, start=0)" },
  { name: "filter", kind: "function", detail: "filter(fn, iterable)" },
  { name: "float", kind: "class", detail: "float(x)" },
  { name: "format", kind: "function", detail: "format(value, spec)" },
  { name: "getattr", kind: "function", detail: "getattr(obj, name, default=None)" },
  { name: "hasattr", kind: "function", detail: "hasattr(obj, name)" },
  { name: "hash", kind: "function", detail: "hash(obj)" },
  { name: "hex", kind: "function", detail: "hex(i)" },
  { name: "input", kind: "function", detail: "input(prompt='')" },
  { name: "int", kind: "class", detail: "int(x, base=10)" },
  { name: "isinstance", kind: "function", detail: "isinstance(obj, classinfo)" },
  { name: "issubclass", kind: "function", detail: "issubclass(cls, classinfo)" },
  { name: "iter", kind: "function", detail: "iter(obj)" },
  { name: "len", kind: "function", detail: "len(obj)" },
  { name: "list", kind: "class", detail: "list(iterable=())" },
  { name: "map", kind: "function", detail: "map(fn, iterable, ...)" },
  { name: "max", kind: "function", detail: "max(iterable, key=None, default=...)" },
  { name: "min", kind: "function", detail: "min(iterable, key=None, default=...)" },
  { name: "next", kind: "function", detail: "next(iterator, default=...)" },
  { name: "open", kind: "function", detail: "open(file, mode='r')" },
  { name: "ord", kind: "function", detail: "ord(c)" },
  { name: "print", kind: "function", detail: "print(*values, sep=' ', end='\\n')" },
  { name: "range", kind: "function", detail: "range(stop) / range(start, stop, step)" },
  { name: "repr", kind: "function", detail: "repr(obj)" },
  { name: "reversed", kind: "function", detail: "reversed(sequence)" },
  { name: "round", kind: "function", detail: "round(number, ndigits=None)" },
  { name: "set", kind: "class", detail: "set(iterable=())" },
  { name: "sorted", kind: "function", detail: "sorted(iterable, key=None, reverse=False)" },
  { name: "str", kind: "class", detail: "str(obj)" },
  { name: "sum", kind: "function", detail: "sum(iterable, start=0)" },
  { name: "super", kind: "function", detail: "super()" },
  { name: "tuple", kind: "class", detail: "tuple(iterable=())" },
  { name: "type", kind: "function", detail: "type(obj)" },
  { name: "zip", kind: "function", detail: "zip(*iterables, strict=False)" },
  { name: "Exception", kind: "class", detail: "Exception" },
  { name: "ValueError", kind: "class", detail: "ValueError" },
  { name: "TypeError", kind: "class", detail: "TypeError" },
  { name: "KeyError", kind: "class", detail: "KeyError" },
  { name: "IndexError", kind: "class", detail: "IndexError" },
  { name: "RuntimeError", kind: "class", detail: "RuntimeError" },
  { name: "StopIteration", kind: "class", detail: "StopIteration" },
  { name: "ZeroDivisionError", kind: "class", detail: "ZeroDivisionError" },
];

export const PY_SNIPPETS: readonly SnippetSpec[] = [
  { label: "def", description: "function", insertText: "def ${1:name}(${2:args}):\n    ${3:pass}$0" },
  { label: "for", description: "for loop", insertText: "for ${1:item} in ${2:iterable}:\n    ${3:pass}$0" },
  { label: "if", description: "if block", insertText: "if ${1:condition}:\n    ${2:pass}$0" },
  {
    label: "ifelse",
    description: "if / else",
    insertText: "if ${1:condition}:\n    ${2:pass}\nelse:\n    ${3:pass}$0",
  },
  {
    label: "try",
    description: "try / except",
    insertText: "try:\n    ${1:pass}\nexcept ${2:Exception} as ${3:e}:\n    ${4:raise}$0",
  },
  {
    label: "with",
    description: "with block",
    insertText: "with ${1:expression} as ${2:name}:\n    ${3:pass}$0",
  },
  {
    label: "listcomp",
    description: "list comprehension",
    insertText: "[${1:expression} for ${2:item} in ${3:iterable}]$0",
  },
  {
    label: "dictcomp",
    description: "dict comprehension",
    insertText: "{${1:key}: ${2:value} for ${3:item} in ${4:iterable}}$0",
  },
  {
    label: "main",
    description: "__main__ guard",
    insertText: 'if __name__ == "__main__":\n    ${1:main()}$0',
  },
];
