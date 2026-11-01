/** Renders a JSON value from the harness. {"__repr__": "..."} is shown verbatim. */
export function formatValue(v: unknown): string {
  if (v && typeof v === "object" && "__repr__" in (v as Record<string, unknown>))
    return String((v as Record<string, unknown>).__repr__);
  if (v === undefined) return "";
  const unwrap = (_k: string, x: unknown) =>
    x && typeof x === "object" && "__repr__" in (x as Record<string, unknown>) ? (x as Record<string, unknown>).__repr__ : x;
  const compact = JSON.stringify(v, unwrap);
  if (compact === undefined) return String(v);
  if (compact.length <= 100) return spaced(compact);
  return JSON.stringify(v, unwrap, 2);
}

/** Add a space after , and : outside of strings. */
function spaced(json: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const c of json) {
    out += c;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "," || c === ":") out += " ";
  }
  return out;
}

export function Value({
  label,
  value,
  mono = true,
  raw = false,
  tone,
}: {
  label: string;
  value: unknown;
  mono?: boolean;
  raw?: boolean;
  tone?: "fail";
}) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <pre className={"field-value" + (mono ? " mono" : "") + (tone ? ` tone-${tone}` : "")}>{raw && typeof value === "string" ? value : formatValue(value)}</pre>
    </div>
  );
}
