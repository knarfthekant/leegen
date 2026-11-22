// Browser edition: export everything (problems, tutorials and work) as a data-layout zip, or
// import one. The browser store is the only store; there is no folder to sync with.

import { Download, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { getBackend } from "../backend";
import type { ImportSummary } from "../backend/types";
import { IconButton } from "./ui";

const failed = (path: string, error: unknown): ImportSummary => ({
  problems: [], tutorials: [], unchanged: [], workspaces: [], errors: [{ path, error: String((error as Error).message ?? error) }],
});

export function TransferButtons({ onImported }: { onImported?: (s: ImportSummary) => void }) {
  const transfer = getBackend().transfer;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!transfer) return null;

  const doExport = async () => {
    setBusy(true);
    try {
      const blob = await transfer.exportZip();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `leegen-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      onImported?.(await transfer.importZip(file));
    } catch (e) {
      onImported?.(failed(file.name, e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <IconButton icon={Download} label="Export problems, tutorials and work (zip, data layout)" onClick={doExport} disabled={busy} />
      <IconButton icon={Upload} label="Import a zip (problems/, tutorials/ and workspace/)" onClick={() => input.current?.click()} disabled={busy} />
      <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={(e) => doImport(e.target.files?.[0])} />
    </>
  );
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function ImportReport({ summary, onClose }: { summary: ImportSummary; onClose: () => void }) {
  const hasErrors = summary.errors.length > 0;
  const parts = [
    plural(summary.problems.length, "problem"),
    ...(summary.tutorials.length ? [plural(summary.tutorials.length, "tutorial")] : []),
  ];
  return (
    <div className={`soft-alert ${hasErrors ? "tone-warn" : "tone-pass"}`}>
      <div className="soft-alert-body">
        <strong>
          Imported {parts.join(" and ")}
          {summary.unchanged.length ? `, ${summary.unchanged.length} unchanged` : ""}
          {summary.workspaces.length ? `, work for ${summary.workspaces.length}` : ""}
        </strong>
        {summary.errors.map((e) => (
          <details key={e.path}>
            <summary>{e.path}</summary>
            <pre>{e.error}</pre>
          </details>
        ))}
      </div>
      <IconButton icon={X} label="Dismiss" onClick={onClose} />
    </div>
  );
}
