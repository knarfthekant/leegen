import { LoaderCircle } from "lucide-react";
import type { AgentStatus } from "../contracts/generated";
import { Chip } from "./ui";

/** App-wide, advisory status: the agent can work before any problem exists. */
export function AgentStatusBanner({ status }: { status: AgentStatus | null }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className={status ? "agent-banner tone-accent" : undefined}>
      {status && <>
        <LoaderCircle size={17} className="spin" aria-hidden="true" />
        <strong>{status.status === "reviewing" ? "Agent is reviewing your code" : "Agent is creating a problem"}</strong>
        <Chip tone="accent">Please wait</Chip>
      </>}
    </div>
  );
}
