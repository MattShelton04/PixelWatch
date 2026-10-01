// Test-only worker for png-decode.test.ts: accepts jobs and never answers.
import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => undefined);
