// WGSL (WebGPU Shading Language) for Monaco: syntax highlighting and brackets for `.wgsl` files
// in the browser edition's WebGPU problems. Monaco ships no WGSL support.
import type * as Monaco from "monaco-editor/editor";

const KEYWORDS = [
  "alias", "break", "case", "const", "const_assert", "continue", "continuing", "default",
  "diagnostic", "discard", "else", "enable", "fn", "for", "if", "let", "loop", "override",
  "requires", "return", "struct", "switch", "var", "while", "true", "false",
];
const TYPES = [
  "bool", "f16", "f32", "i32", "u32", "vec2", "vec3", "vec4", "mat2x2", "mat2x3", "mat2x4",
  "mat3x2", "mat3x3", "mat3x4", "mat4x2", "mat4x3", "mat4x4", "array", "atomic", "ptr",
  "sampler", "sampler_comparison", "texture_2d", "texture_storage_2d", "vec2f", "vec3f", "vec4f",
  "vec2i", "vec3i", "vec4i", "vec2u", "vec3u", "vec4u", "mat4x4f",
];
const BUILTINS = [
  "arrayLength", "workgroupBarrier", "storageBarrier", "textureBarrier", "atomicAdd",
  "atomicLoad", "atomicStore", "atomicMax", "atomicMin", "select", "min", "max", "clamp", "abs",
  "sqrt", "exp", "log", "pow", "dot", "cross", "normalize", "length", "floor", "ceil", "fma",
  "mix", "bitcast", "workgroupUniformLoad",
];
const ADDRESS = ["function", "private", "workgroup", "uniform", "storage", "read", "write", "read_write"];

export function registerWgsl(monaco: typeof Monaco) {
  monaco.languages.register({ id: "wgsl", extensions: [".wgsl"], aliases: ["WGSL", "wgsl"] });
  monaco.languages.setLanguageConfiguration("wgsl", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
    ],
  });
  monaco.languages.setMonarchTokensProvider("wgsl", {
    keywords: KEYWORDS,
    types: TYPES,
    builtins: BUILTINS,
    address: ADDRESS,
    tokenizer: {
      root: [
        [/@[a-zA-Z_]\w*/, "annotation"],
        [/[a-zA-Z_]\w*/, {
          cases: {
            "@keywords": "keyword",
            "@types": "type",
            "@builtins": "predefined",
            "@address": "keyword",
            "@default": "identifier",
          },
        }],
        { include: "@whitespace" },
        [/[{}()[\]]/, "@brackets"],
        [/0[xX][0-9a-fA-F]+[iu]?/, "number.hex"],
        [/(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?[fh]?/, "number"],
        [/[<>=!&|+\-*/%^~]+/, "operator"],
        [/[;,.:]/, "delimiter"],
      ],
      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\/\*/, "comment", "@push"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });
}
