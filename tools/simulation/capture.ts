// Canary strings exist only in memory, never in committed testdata or API recordings.
export const CANARY_TOKEN = "pw-simulation-canary-token-DO-NOT-PUBLISH";
export const SIGNED_URL = "https://blob.simulation.invalid/artifact.zip?sig=simulation-canary-signature";
const secrets = [CANARY_TOKEN, SIGNED_URL, "simulation-canary-signature"];
const encodings = secrets.flatMap((s) => [s, encodeURIComponent(s), Buffer.from(s).toString("base64")]);
function clean(value: string): string {
  for (const secret of encodings) value = value.replaceAll(secret, "[redacted]");
  // Never emit any signed query, even for future fixtures not using our canary.
  return value.replace(/https:\/\/[^\s"<>]+/g, "[url]").replace(/[^\x20-\x7e\n]/g, "?").slice(0, 2048);
}
export function assertNoSecrets(values: readonly (string | Uint8Array)[]): void {
  for (const value of values) {
    const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
    if (encodings.some((s) => text.includes(s))) throw new Error("simulation-secret-leak");
  }
}
export class Capture {
  readonly logs: string[] = [];
  readonly summaries: string[] = [];
  readonly errors: string[] = [];
  readonly files = new Map<string, string>();
  log(value: string): void { this.logs.push(clean(value)); }
  summary(value: string): void { this.summaries.push(clean(value)); }
  error(error: unknown): void { this.errors.push(clean(error instanceof Error ? error.message : "unknown-error")); }
  store(path: string, value: string): void {
    if (!/^[a-z0-9.-]+$/.test(path)) throw new Error("capture-path-invalid");
    this.files.set(path, clean(value));
  }
  assertClean(): void { assertNoSecrets([...this.logs, ...this.summaries, ...this.errors, ...this.files.keys(), ...this.files.values()]); }
}
