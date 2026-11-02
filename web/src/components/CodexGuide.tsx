import { Check, Copy, MessageSquare, Minus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button, IconButton } from "./ui";

const PROMPT = "Open https://leegen.frankshan.workers.dev in your browser and create a coding problem based on my recent Codex activity.";

export function CodexGuide() {
  const [open, setOpen] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const prompt = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const panelId = useId();

  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(PROMPT);
      setCopyState("copied");
    } catch {
      setCopyState("error");
      prompt.current?.focus();
      prompt.current?.select();
    }
  };

  if (!open) return (
    <div className="codex-guide-launcher">
      <Button icon={MessageSquare} onClick={() => setOpen(true)} aria-expanded={false} aria-controls={panelId}>
        Use with Codex
      </Button>
    </div>
  );

  return (
    <aside className="codex-guide" id={panelId} aria-labelledby={titleId}>
      <div className="codex-guide-head">
        <span className="codex-guide-icon"><MessageSquare size={17} strokeWidth={1.8} aria-hidden /></span>
        <h2 id={titleId}>Practice with Codex</h2>
        <IconButton icon={Minus} label="Minimize Codex guide" onClick={() => setOpen(false)} />
      </div>
      <p className="codex-guide-intro">Paste this into a Codex chat with your recent work. Codex will open leegen and create a problem tailored to you.</p>
      <textarea className="codex-guide-prompt" ref={prompt} aria-label="Prompt for Codex" readOnly value={PROMPT} rows={4} />
      <Button className="codex-guide-copy" icon={copyState === "copied" ? Check : Copy} variant="accent" onClick={() => void copy()}>
        <span aria-live="polite">{copyState === "copied" ? "Copied" : "Copy prompt"}</span>
      </Button>
      {copyState === "error" && <p className="codex-guide-feedback" role="status">Copy is unavailable. The prompt is selected so you can copy it manually.</p>}
    </aside>
  );
}
