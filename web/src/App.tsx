import { ProblemList } from "./pages/ProblemList";
import { WorkspacePage } from "./pages/Workspace";
import { TutorialPage } from "./pages/Tutorial";
import { usePath } from "./lib/router";
import { getBackend } from "./backend";
import { CodexGuide } from "./components/CodexGuide";
import { AgentStatusBanner } from "./components/AgentStatusBanner";
import { useAgentStatus } from "./lib/agentStatus";

export function App() {
  const path = usePath();
  const activity = useAgentStatus();
  const m = path.match(/^\/p\/([^/]+)/);
  const t = path.match(/^\/t\/([^/]+)/);
  return (
    <div className="app-shell">
      <div className="app-page">
        {m ? <WorkspacePage key={m[1]} id={decodeURIComponent(m[1])} />
          : t ? <TutorialPage key={t[1]} id={decodeURIComponent(t[1])} />
          : <ProblemList />}
      </div>
      <AgentStatusBanner status={activity} />
      {getBackend().edition === "browser" && <CodexGuide hidden={activity !== null} />}
    </div>
  );
}
