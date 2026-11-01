import * as monaco from "monaco-editor/editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
// editor features (hover, find, folding, diff editor, codicon font, ...); languages are opt-in below
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/shell/register";
import { loader } from "@monaco-editor/react";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
// exposed for debugging and the browser smoke test
(window as unknown as { monaco: typeof monaco }).monaco = monaco;
loader.config({ monaco });

monaco.editor.defineTheme("lc-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editorLineNumber.foreground": "#a3a3a3",
    "diffEditor.insertedLineBackground": "#16a34a14",
    "diffEditor.insertedTextBackground": "#16a34a2e",
    "diffEditor.removedLineBackground": "#dc262612",
    "diffEditor.removedTextBackground": "#dc26262a",
    "diffEditorGutter.insertedLineBackground": "#16a34a1f",
    "diffEditorGutter.removedLineBackground": "#dc26261c",
  },
});
monaco.editor.defineTheme("lc-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1b1b1b",
    "editorLineNumber.foreground": "#5c5c5c",
    "diffEditor.insertedLineBackground": "#4ade8014",
    "diffEditor.insertedTextBackground": "#4ade802a",
    "diffEditor.removedLineBackground": "#f8717114",
    "diffEditor.removedTextBackground": "#f871712a",
    "diffEditorGutter.insertedLineBackground": "#4ade801c",
    "diffEditorGutter.removedLineBackground": "#f871711c",
  },
});

const EXT: Record<string, string> = {
  py: "python", cu: "cpp", cuh: "cpp", cpp: "cpp", cc: "cpp", h: "cpp", hpp: "cpp",
  ts: "typescript", tsx: "typescript", js: "javascript", yaml: "yaml", yml: "yaml",
  md: "markdown", sh: "shell",
};

export function languageFor(path: string, override?: string | null): string {
  if (override) return override;
  const ext = path.split(".").pop() ?? "";
  return EXT[ext] ?? "plaintext";
}

export { monaco };
