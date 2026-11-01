import { ProblemList } from "./pages/ProblemList";
import { WorkspacePage } from "./pages/Workspace";
import { usePath } from "./lib/router";

export function App() {
  const path = usePath();
  const m = path.match(/^\/p\/([^/]+)/);
  if (m) return <WorkspacePage key={m[1]} id={decodeURIComponent(m[1])} />;
  return <ProblemList />;
}
