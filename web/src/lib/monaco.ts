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
import { registerWgsl } from "./wgsl";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
// exposed for debugging and the browser smoke test
(window as unknown as { monaco: typeof monaco }).monaco = monaco;
loader.config({ monaco });
registerWgsl(monaco);

monaco.editor.defineTheme("lc-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editorGutter.background": "#ffffff",
    "editorLineNumber.foreground": "#b8b8b4",
    "editorLineNumber.activeForeground": "#57534e",
    "editor.lineHighlightBackground": "#f6f6f4",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#c9d7f2",
    "editor.inactiveSelectionBackground": "#e3e9f5",
    "editorIndentGuide.background1": "#efefec",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#e7e7e4",
    "scrollbarSlider.background": "#0000000f",
    "scrollbarSlider.hoverBackground": "#0000001f",
    "scrollbarSlider.activeBackground": "#0000002b",
    "editorOverviewRuler.border": "#00000000",
    "focusBorder": "#00000000",
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
    "editor.background": "#1c1c1e",
    "editorGutter.background": "#1c1c1e",
    "editorLineNumber.foreground": "#4f4f53",
    "editorLineNumber.activeForeground": "#a1a1a6",
    "editor.lineHighlightBackground": "#232326",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#34405a",
    "editor.inactiveSelectionBackground": "#2b3242",
    "editorIndentGuide.background1": "#2a2a2d",
    "editorWidget.background": "#232326",
    "editorWidget.border": "#2f2f33",
    "scrollbarSlider.background": "#ffffff12",
    "scrollbarSlider.hoverBackground": "#ffffff22",
    "scrollbarSlider.activeBackground": "#ffffff2e",
    "editorOverviewRuler.border": "#00000000",
    "focusBorder": "#00000000",
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
  md: "markdown", sh: "shell", wgsl: "wgsl",
};

export function languageFor(path: string, override?: string | null): string {
  if (override) return override;
  const ext = path.split(".").pop() ?? "";
  return EXT[ext] ?? "plaintext";
}

export { monaco };
