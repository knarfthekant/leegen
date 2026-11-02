import { ProblemList } from "./pages/ProblemList";
import { WorkspacePage } from "./pages/Workspace";
import { usePath } from "./lib/router";
import { getBackend } from "./backend";
import { CodexGuide } from "./components/CodexGuide";

export function App() {
  const path = usePath();
  const m = path.match(/^\/p\/([^/]+)/);
  return (
    <>
      {m ? <WorkspacePage key={m[1]} id={decodeURIComponent(m[1])} /> : <ProblemList />}
      {getBackend().edition === "browser" && <CodexGuide />}
    </>
  );
}
