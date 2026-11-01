import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import "katex/dist/katex.min.css";
import { Mermaid } from "./Mermaid";

/* Directives:  :::note  :::warning  :::details{summary="..."}  :::figure{caption="..."} */
type DirectiveNode = {
  type: string;
  name: string;
  attributes?: Record<string, string | null | undefined>;
  children: unknown[];
  data?: Record<string, unknown>;
};

function remarkLeetclaudeDirectives() {
  return (tree: unknown) => {
    visit(tree as never, (node: DirectiveNode) => {
      if (node.type !== "containerDirective" && node.type !== "leafDirective") return;
      const attrs = node.attributes ?? {};
      const data = (node.data ??= {});
      switch (node.name) {
        case "note":
        case "tip":
        case "warning":
          data.hName = "div";
          data.hProperties = { className: ["callout", `callout-${node.name}`] };
          break;
        case "details":
          data.hName = "details";
          node.children.unshift({
            type: "paragraph",
            data: { hName: "summary" },
            children: [{ type: "text", value: attrs.summary ?? "Details" }],
          });
          break;
        case "figure":
          data.hName = "figure";
          if (attrs.caption)
            node.children.push({
              type: "paragraph",
              data: { hName: "figcaption" },
              children: [{ type: "text", value: attrs.caption }],
            });
          break;
        default:
          data.hName = "div";
          data.hProperties = { className: ["callout"] };
      }
    });
  };
}

const SVG_TAGS = [
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text",
  "tspan", "defs", "marker", "title", "desc", "linearGradient", "stop", "pattern", "clipPath",
];
const SVG_ATTRS = [
  "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "d", "points", "fill", "fillOpacity", "stroke", "strokeWidth", "strokeDasharray",
  "strokeLinecap", "strokeLinejoin", "strokeOpacity", "opacity", "transform", "fontSize",
  "fontFamily", "fontWeight", "textAnchor", "dominantBaseline", "markerEnd", "markerStart",
  "markerWidth", "markerHeight", "refX", "refY", "orient", "dx", "dy", "offset", "stopColor",
  "preserveAspectRatio", "xmlns", "id", "clipPath", "patternUnits",
];

const schema = {
  ...defaultSchema,
  clobberPrefix: "md-",
  tagNames: [...(defaultSchema.tagNames ?? []), "figure", "figcaption", ...SVG_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div ?? []), ["className", "callout", /^callout-/]],
    code: [["className", /^language-./, "math-inline", "math-display"]],
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height"],
    ...Object.fromEntries(SVG_TAGS.map((t) => [t, SVG_ATTRS])),
  },
};

function resolveAsset(problemId: string | undefined, src: string | undefined) {
  if (!src || !problemId || /^(https?:|data:|\/)/.test(src)) return src;
  return `/api/problems/${encodeURIComponent(problemId)}/${src.replace(/^\.\//, "")}`;
}

function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

export const Markdown = memo(function Markdown({
  source,
  problemId,
}: {
  source: string;
  problemId?: string;
}) {
  const components: Components = {
    pre({ children, node }) {
      const code = node?.children?.[0] as { properties?: { className?: string[] } } | undefined;
      if (code?.properties?.className?.includes("language-mermaid")) {
        const el = children as { props?: { children?: ReactNode } };
        return <Mermaid code={textOf(el?.props?.children ?? "")} />;
      }
      return <pre>{children}</pre>;
    },
    img({ src, alt, ...rest }) {
      return <img src={resolveAsset(problemId, src as string)} alt={alt ?? ""} {...rest} />;
    },
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkDirective, remarkLeetclaudeDirectives]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, schema],
          rehypeKatex,
          [rehypeHighlight, { plainText: ["mermaid", "text"] }],
        ]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
