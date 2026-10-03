// Cooperative, step-bounded scheduling. No timer, wall clock or ambient randomness.
export const SEEDS = [1, 42, 0x5eed1234, 0xffffffff] as const;
export class Clock {
  #now = 946684800000;
  get now(): number { return this.#now; }
  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isSafeInteger(this.#now + ms)) throw new Error("clock-invalid");
    this.#now += ms;
  }
}

interface Step { point: string; action: (() => void) | undefined; barrier: string | undefined }
export function checkpoint(point: string, action?: () => void, barrier?: string): Step {
  return { point, action, barrier };
}
interface Actor { program: Generator<Step, void, void>; blocked: boolean; done: boolean }
interface Barrier { members: Set<string>; arrivals: Set<string>; released: boolean }
export class Scheduler {
  readonly trace: string[] = [];
  readonly seed: number;
  #state: number;
  #limit: number;
  #actors = new Map<string, Actor>();
  #barriers = new Map<string, Barrier>();
  constructor(seed: number, limit = 1024) {
    if (!Number.isInteger(seed) || seed < 1 || seed > 0xffffffff || !Number.isSafeInteger(limit) || limit < 1) throw new Error("schedule-invalid");
    this.seed = seed;
    this.#state = seed >>> 0;
    this.#limit = limit;
  }
  barrier(name: string, members: readonly string[]): void {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || this.#barriers.has(name) || members.length < 2 || new Set(members).size !== members.length) throw new Error("barrier-ambiguous");
    this.#barriers.set(name, { members: new Set(members), arrivals: new Set(), released: false });
  }
  add(name: string, program: () => Generator<Step, void, void>): void {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || this.#actors.has(name)) throw new Error("actor-ambiguous");
    this.#actors.set(name, { program: program(), blocked: false, done: false });
  }
  run(): void {
    if (this.#actors.size === 0) throw new Error(`schedule-empty seed=${String(this.seed)}`);
    for (let step = 0; step < this.#limit; step++) {
      if ([...this.#actors.values()].every((a) => a.done)) {
        if ([...this.#barriers.values()].some((b) => !b.released)) throw new Error(`barrier-not-reached seed=${String(this.seed)}`);
        return;
      }
      const choices = [...this.#actors.keys()].sort().filter((k) => {
        const a = this.#actors.get(k);
        return a !== undefined && !a.done && !a.blocked;
      });
      if (choices.length === 0) throw new Error(`schedule-deadlock seed=${String(this.seed)}`);
      let x = this.#state;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      this.#state = x >>> 0;
      const name = choices[this.#state % choices.length];
      const actor = name === undefined ? undefined : this.#actors.get(name);
      if (actor === undefined || name === undefined) throw new Error(`schedule-invalid seed=${String(this.seed)}`);
      try {
        const next = actor.program.next();
        if (next.done) { actor.done = true; this.trace.push(`${name}:done`); continue; }
        const { point, action, barrier } = next.value;
        if (!/^[a-z][a-z0-9-]*$/.test(point)) throw new Error("point-invalid");
        this.trace.push(`${name}:${point}`);
        action?.();
        if (barrier !== undefined) {
          const b = this.#barriers.get(barrier);
          if (b === undefined || b.released || !b.members.has(name) || b.arrivals.has(name)) throw new Error("barrier-invalid");
          b.arrivals.add(name);
          actor.blocked = true;
          if (b.arrivals.size === b.members.size) {
            b.released = true;
            for (const member of b.members) {
              const arrived = this.#actors.get(member);
              if (arrived === undefined) throw new Error("barrier-missing-actor");
              arrived.blocked = false;
            }
            this.trace.push(`release:${barrier}`);
          }
        }
      } catch {
        // Actor errors may contain hostile fixture data. The seed/point trace is sufficient to replay.
        throw new Error(`schedule-action-failed seed=${String(this.seed)} step=${String(step)}`);
      }
    }
    throw new Error(`schedule-step-limit seed=${String(this.seed)}`);
  }
}
