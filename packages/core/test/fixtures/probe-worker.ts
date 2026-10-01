// Test-only worker for png-decode.test.ts: replies to each job with the most jobs it ever saw in
// flight at once, so the test can prove PngWorker sends one job at a time.
import { setTimeout as sleep } from "node:timers/promises";
import { parentPort } from "node:worker_threads";

let inFlight = 0;
let most = 0;
parentPort?.on("message", (message: { id: number }) => {
  inFlight++;
  most = Math.max(most, inFlight);
  void sleep(20).then(() => {
    inFlight--;
    parentPort?.postMessage({ id: message.id, ok: true, value: most });
  });
});
