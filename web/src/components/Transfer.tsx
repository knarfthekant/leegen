// Browser edition: export everything (problems + work) as a repo-layout zip, or import one.

import { Download, FolderInput, FolderOutput, Upload, X } from "lucide-react";
import { type MouseEvent, useRef, useState } from "react";
import { getBackend } from "../backend";
import type { ImportSummary } from "../backend/types";
import { IconButton } from "./ui";

export function TransferButtons({
  onImported,
  onSaved,
}: {
  onImported?: (s: ImportSummary & { folder?: string }) => void;
  onSaved?: (s: { folder: string; written: number }) => void;
}) {
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
      onImported?.({ problems: [], unchanged: [], workspaces: [], errors: [{ path: file.name, error: String((e as Error).message ?? e) }] });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const folder = transfer.folder;
  // Shift-click picks a different folder instead of the remembered one.
  const withFolder = (fn: (pickNew: boolean) => Promise<void>) => async (e: MouseEvent) => {
    setBusy(true);
    try {
      await fn(e.shiftKey);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onImported?.({ problems: [], unchanged: [], workspaces: [], errors: [{ path: "folder", error: String((err as Error).message ?? err) }] });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {folder && (
        <>
          <IconButton
            icon={FolderOutput}
            label="Save to a folder (problems/ and workspace/; shift-click to choose another folder)"
            onClick={withFolder(async (pickNew) => onSaved?.(await folder.save(pickNew)))}
            disabled={busy}
          />
          <IconButton
            icon={FolderInput}
            label="Load from a folder (a leegen checkout; shift-click to choose another folder)"
            onClick={withFolder(async (pickNew) => onImported?.(await folder.load(pickNew)))}
            disabled={busy}
          />
        </>
      )}
      <IconButton icon={Download} label="Export problems and work (zip, repo layout)" onClick={doExport} disabled={busy} />
      <IconButton icon={Upload} label="Import a zip (problems/ and workspace/)" onClick={() => input.current?.click()} disabled={busy} />
      <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={(e) => doImport(e.target.files?.[0])} />
    </>
  );
}

export function ImportReport({ summary, onClose }: { summary: ImportSummary & { folder?: string }; onClose: () => void }) {
  const failed = summary.errors.length > 0;
  return (
    <div className={`soft-alert ${failed ? "tone-warn" : "tone-pass"}`}>
      <div className="soft-alert-body">
        <strong>
          Imported {summary.problems.length} problem{summary.problems.length === 1 ? "" : "s"}
          {summary.unchanged.length ? `, ${summary.unchanged.length} unchanged` : ""}
          {summary.workspaces.length ? `, work for ${summary.workspaces.length}` : ""}
          {summary.folder ? ` from “${summary.folder}”` : ""}
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

export function SavedReport({ saved, onClose }: { saved: { folder: string; written: number }; onClose: () => void }) {
  return (
    <div className="soft-alert tone-pass">
      <div className="soft-alert-body">
        <strong>
          Saved to “{saved.folder}”: {saved.written} file{saved.written === 1 ? "" : "s"} changed
        </strong>
      </div>
      <IconButton icon={X} label="Dismiss" onClick={onClose} />
    </div>
  );
}
