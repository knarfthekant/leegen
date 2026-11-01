import { useEffect, useId, useState } from "react";
import { useDark } from "../lib/theme";

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
        ? { background: "transparent", primaryColor: "#2c2c30", primaryTextColor: "#ececef",
            primaryBorderColor: "#4a4a50", lineColor: "#8a8a92", secondaryColor: "#232326",
            tertiaryColor: "#232326", noteBkgColor: "#2c2c30", noteTextColor: "#ececef",
            actorBkg: "#2c2c30", actorBorder: "#4a4a50", actorTextColor: "#ececef",
            signalColor: "#c8c8cc", signalTextColor: "#ececef" }
        : { background: "transparent", primaryColor: "#f3f3f1", primaryTextColor: "#1d1d1f",
            primaryBorderColor: "#cfcfcb", lineColor: "#7a7a7e", secondaryColor: "#f7f7f5",
            tertiaryColor: "#f7f7f5", noteBkgColor: "#f3f3f1", noteTextColor: "#1d1d1f" },
    });
    return mermaid;
  });
}

export function Mermaid({ code }: { code: string }) {
  const id = "mmd" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dark = useDark();

  useEffect(() => {
    let alive = true;
    loadMermaid(dark)
      .then((m) => m.render(id, code))
      .then((r) => alive && setSvg(r.svg))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [code, id, dark]);

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
