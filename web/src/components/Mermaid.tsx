import { useEffect, useId, useState } from "react";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid(dark: boolean) {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  return mermaidPromise.then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: "inherit",
      themeVariables: dark
        ? { background: "transparent", primaryColor: "#262626", primaryTextColor: "#e5e5e5",
            primaryBorderColor: "#737373", lineColor: "#a3a3a3", secondaryColor: "#1f1f1f",
            tertiaryColor: "#1f1f1f", noteBkgColor: "#262626", noteTextColor: "#e5e5e5",
            actorBkg: "#262626", actorBorder: "#737373", actorTextColor: "#e5e5e5",
            signalColor: "#d4d4d4", signalTextColor: "#e5e5e5" }
        : { background: "transparent", primaryColor: "#f5f5f5", primaryTextColor: "#171717",
            primaryBorderColor: "#737373", lineColor: "#525252", secondaryColor: "#fafafa",
            tertiaryColor: "#fafafa", noteBkgColor: "#f5f5f5", noteTextColor: "#171717" },
    });
    return mermaid;
  });
}

export function Mermaid({ code }: { code: string }) {
  const id = "mmd" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    loadMermaid(dark)
      .then((m) => m.render(id, code))
      .then((r) => alive && setSvg(r.svg))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [code, id]);

  if (error)
    return (
      <pre className="mermaid-error">
        {code}
        {"\n\n"}diagram error: {error}
      </pre>
    );
  if (!svg) return <div className="mermaid loading">rendering diagram…</div>;
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
