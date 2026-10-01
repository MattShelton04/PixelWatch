// Test-only worker for png-decode.test.ts: throws on the first job, as a decoder bug would.
import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => {
  throw new Error("simulated worker crash");
});
