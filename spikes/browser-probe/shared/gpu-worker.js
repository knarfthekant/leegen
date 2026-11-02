import { runComputeProbe } from "./gpu.js";

self.onmessage = async () => {
  self.postMessage(await runComputeProbe());
};
