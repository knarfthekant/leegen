// Monaco providers for Python: completions, signature help and a symbol hover.
// Registered once at startup (like the WGSL grammar); the editor remounts per file, so nothing
// here may be per-instance. Symbols come from the open problem's Monaco models plus a snapshot
// the Editor publishes, so files that are not currently open still contribute names.

import type * as Monaco from "monaco-editor/editor";
import { PY_BUILTINS, PY_KEYWORDS, PY_SNIPPETS } from "./pythonCatalog";
import { libraryMembers } from "./pythonLibraries";
import {
  buildSymbolIndex,
  findCallContext,
  parsePythonFile,
  type PyFileParse,
  type PySymbol,
  type PySymbolIndex,
} from "./pythonSymbols";

type MonacoApi = typeof Monaco;

export interface EditorFileLike {
  path: string;
  role: "editable" | "readonly";
  content: string;
  language: string | null;
}

const MAX_PROBLEMS = 4;
const MAX_CACHE = 64;
const MAX_SUGGESTIONS = 200;

const snapshots = new Map<string, readonly EditorFileLike[]>();
const parseCache = new Map<string, { versionKey: string | null; source: string; parsed: PyFileParse }>();
let api: MonacoApi | null = null;
let registered = false;
let hoverRegistered = false;

/** Called by the Editor whenever its visible files or buffers change. Cheap: stores a reference. */
export function setProblemFiles(problemId: string, files: readonly EditorFileLike[]): void {
  if (!problemId) return;
  snapshots.delete(problemId);
  snapshots.set(problemId, files);
  while (snapshots.size > MAX_PROBLEMS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

interface SourceFile {
  path: string;
  source: string;
  versionKey: string | null;
}

function isPythonFile(file: EditorFileLike): boolean {
  return (file.language ?? (file.path.endsWith(".py") ? "python" : "")) === "python";
}

function problemIdOf(model: Monaco.editor.ITextModel): string | null {
  const uri = model.uri;
  return uri.scheme === "inmemory" ? uri.authority || null : null;
}

function pathOf(model: Monaco.editor.ITextModel): string {
  return model.uri.path.replace(/^\//, "");
}

function isVisiblePython(model: Monaco.editor.ITextModel, problemId: string): boolean {
  return model.uri.scheme === "inmemory" && model.uri.authority === problemId
    && model.getLanguageId() === "python" && !pathOf(model).startsWith("diff-");
}

function collectSources(problemId: string, current: Monaco.editor.ITextModel | null): SourceFile[] {
  const snapshot = snapshots.get(problemId);
  const byPath = new Map<string, SourceFile>();
  if (snapshot) {
    for (const file of snapshot) {
      if (isPythonFile(file)) {
        byPath.set(file.path, { path: file.path, source: file.content, versionKey: null });
      }
    }
  }
  for (const model of api?.editor.getModels() ?? []) {
    if (!isVisiblePython(model, problemId)) continue;
    const path = pathOf(model);
    if (snapshot && !byPath.has(path)) continue;   // stale model from an earlier problem load
    byPath.set(path, { path, source: model.getValue(), versionKey: String(model.getVersionId()) });
  }
  if (current && byPath.size === 0 && isVisiblePython(current, problemId)) {
    const path = pathOf(current);
    byPath.set(path, { path, source: current.getValue(), versionKey: String(current.getVersionId()) });
  }
  return [...byPath.values()];
}

function parsedFor(problemId: string, file: SourceFile): PyFileParse {
  const key = `${problemId}\0${file.path}`;
  const hit = parseCache.get(key);
  const fresh = hit && hit.source === file.source;
  if (hit && fresh) {
    parseCache.delete(key);   // refresh LRU position
    parseCache.set(key, hit);
    return hit.parsed;
  }
  const parsed = parsePythonFile(file.path, file.source);
  parseCache.set(key, { versionKey: file.versionKey, source: file.source, parsed });
  while (parseCache.size > MAX_CACHE) {
    const oldest = parseCache.keys().next().value;
    if (oldest === undefined) break;
    parseCache.delete(oldest);
  }
  return parsed;
}

function indexFor(model: Monaco.editor.ITextModel): PySymbolIndex {
  const problemId = problemIdOf(model);
  if (!problemId) {
    const path = pathOf(model);
    return buildSymbolIndex(
      [{ path, symbols: parsePythonFile(path, model.getValue()).symbols }], path);
  }
  const files = collectSources(problemId, model)
    .map((source) => ({ path: source.path, symbols: parsedFor(problemId, source).symbols }));
  return buildSymbolIndex(files, pathOf(model));
}

function kindOf(monaco: MonacoApi, kind: PySymbol["kind"]): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case "function":
      return K.Function;
    case "method":
      return K.Method;
    case "class":
      return K.Class;
    case "module":
      return K.Module;
    default:
      return K.Variable;
  }
}

export function registerEditorIntelligence(monaco: MonacoApi): void {
  api = monaco;
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const index = indexFor(model);
      const currentPath = pathOf(model);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const out: Monaco.languages.CompletionItem[] = [];
      const seen = new Set<string>();
      const before = model.getValue().slice(0, model.getOffsetAt(position) - word.word.length);
      const receiver = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.$/.exec(before);
      const members = receiver ? libraryMembers(before, receiver[1]) : null;
      if (members) {
        return { suggestions: members.map((item) => ({
          label: item.name,
          kind: item.kind === "class" ? monaco.languages.CompletionItemKind.Class
            : item.kind === "function" ? monaco.languages.CompletionItemKind.Function
              : item.kind === "property" ? monaco.languages.CompletionItemKind.Property
                : monaco.languages.CompletionItemKind.Method,
          detail: item.detail,
          insertText: item.name,
          range,
        })) };
      }
      for (const sym of index.symbols) {
        if (seen.has(sym.name)) continue;
        seen.add(sym.name);
        out.push({
          label: sym.name,
          kind: kindOf(monaco, sym.kind),
          detail: sym.signature,
          documentation: {
            value: (sym.doc ? `${sym.doc}\n\n` : "") + `*${sym.path}:${sym.line}*`,
          },
          insertText: sym.name,
          range,
          sortText: (sym.path === currentPath ? "0_" : "1_") + sym.name,
        });
      }
      for (const keyword of PY_KEYWORDS) {
        out.push({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          range,
          sortText: `2_${keyword}`,
        });
      }
      for (const builtin of PY_BUILTINS) {
        out.push({
          label: builtin.name,
          kind: builtin.kind === "class"
            ? monaco.languages.CompletionItemKind.Class
            : monaco.languages.CompletionItemKind.Function,
          detail: builtin.detail,
          insertText: builtin.name,
          range,
          sortText: `3_${builtin.name}`,
        });
      }
      for (const snippet of PY_SNIPPETS) {
        out.push({
          label: snippet.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: snippet.description,
          insertText: snippet.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: `4_${snippet.label}`,
        });
      }
      const prefix = word.word.toLowerCase();
      return { suggestions: out.filter((item) =>
        typeof item.label === "string" && item.label.toLowerCase().includes(prefix))
        .slice(0, MAX_SUGGESTIONS) };
    },
  });

  monaco.languages.registerSignatureHelpProvider("python", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp(model, position) {
      const call = findCallContext(model.getValue(), model.getOffsetAt(position));
      if (!call) return null;
      const signatures: Monaco.languages.SignatureInformation[] = [];
      const seen = new Set<string>();
      for (const sym of indexFor(model).byName.get(call.callee) ?? []) {
        if (!sym.signature.startsWith("def ") && !sym.signature.startsWith("async def ")) continue;
        if (seen.has(sym.signature)) continue;
        seen.add(sym.signature);
        signatures.push({
          label: sym.signature,
          parameters: sym.params.map((param) => ({ label: param })),
          ...(sym.doc ? { documentation: sym.doc } : {}),
        });
        if (signatures.length === 3) break;
      }
      if (signatures.length === 0) return null;
      const first = signatures[0];
      const activeParameter = Math.min(
        call.activeParameter, Math.max(0, (first.parameters?.length ?? 1) - 1));
      return {
        value: { signatures, activeSignature: 0, activeParameter },
        dispose() { /* nothing to release */ },
      };
    },
  });
}

/** Registered after the annotation hover so annotation text renders first. */
export function registerSymbolHover(monaco: MonacoApi): void {
  api = monaco;
  if (hoverRegistered) return;
  hoverRegistered = true;

  monaco.languages.registerHoverProvider("python", {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const symbols = indexFor(model).byName.get(word.word);
      if (!symbols?.length) return null;
      const callable = (sym: PySymbol) =>
        sym.kind === "function" || sym.kind === "method" || sym.kind === "class";
      const sym = symbols.find((s) => s.path === pathOf(model) && callable(s))
        ?? symbols.find(callable);
      if (!sym) return null;
      const contents = [{ value: `\`\`\`python\n${sym.signature}\n\`\`\`` }];
      if (sym.doc) contents.push({ value: sym.doc });
      contents.push({ value: `*${sym.path}:${sym.line}*` });
      return {
        range: new monaco.Range(
          position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents,
      };
    },
  });
}
