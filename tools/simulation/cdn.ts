import { Clock } from "./schedule.ts";
import { assertNoSecrets } from "./capture.ts";
export const TTLS = [0, 60, 600, 900] as const;
export interface Served { status: 200 | 404; body: string; generation: string }
export class Cdn {
  #clock: Clock;
  #ttl: number;
  #origin = new Map<string, Served>();
  #known = new Set<string>();
  #cache = new Map<string, { until: number; value: Served }>();
  #scripts = new Map<string, Served[]>();
  readonly trace: string[] = [];
  constructor(clock: Clock, ttl: number) {
    if (!Number.isSafeInteger(ttl) || ttl < 0) throw new Error("cdn-invalid-ttl");
    this.#clock = clock; this.#ttl = ttl;
  }
  deploy(generation: string, files: ReadonlyMap<string, string>): void {
    assertNoSecrets([...files.keys(), ...files.values()]);
    if (!/^[a-z0-9-]+$/.test(generation)) throw new Error("cdn-invalid-generation");
    const next = new Map<string, Served>();
    for (const [path, body] of files) {
      this.#validate("origin", path);
      this.#known.add(path);
      next.set(path, { status: 200, body, generation });
    }
    for (const path of this.#known) if (!next.has(path)) next.set(path, { status: 404, body: "", generation });
    this.#origin = next;
    this.trace.push(`deploy:${generation}`);
  }
  script(edge: string, path: string, replies: readonly Served[]): void {
    const key = this.#validate(edge, path);
    if (!this.#known.has(path) || this.#scripts.has(key) || replies.length === 0) throw new Error("cdn-ambiguous-script");
    this.#scripts.set(key, structuredClone([...replies]));
  }
  get(edge: string, path: string): Served {
    const key = this.#validate(edge, path);
    if (!this.#known.has(path)) throw new Error("cdn-unknown-path");
    const script = this.#scripts.get(key);
    if (script !== undefined) {
      const reply = script.shift();
      if (reply === undefined) throw new Error("cdn-script-exhausted");
      this.trace.push(`${edge}:${path}:${String(reply.status)}:${reply.generation}`);
      return { ...reply };
    }
    const cached = this.#cache.get(key);
    const value = cached !== undefined && this.#clock.now < cached.until ? cached.value : this.#origin.get(path);
    if (value === undefined) throw new Error("cdn-unknown-path");
    if (cached === undefined || this.#clock.now >= cached.until) this.#cache.set(key, { until: this.#clock.now + this.#ttl * 1000, value: { ...value } });
    this.trace.push(`${edge}:${path}:${String(value.status)}:${value.generation}`);
    return { ...value };
  }
  #validate(edge: string, path: string): string {
    if (!/^[a-z][a-z0-9-]*$/.test(edge) || !/^[a-z0-9][a-z0-9/_.-]*$/.test(path) || path.split("/").some((p) => p === "." || p === ".." || p === "")) throw new Error("cdn-invalid-request");
    return `${edge}:${path}`;
  }
}
