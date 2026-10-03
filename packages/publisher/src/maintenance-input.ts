import { isGitHubId, parseRunKey, type Run } from "@pixelwatch/schemas";
import { STORE_LIMITS, type CasResult, type StoreAdapter, type StoreSnapshot } from "@pixelwatch/store";
import { captureContext } from "./assembly-input.ts";
import { captureSnapshot, checkedTip } from "./admission-input.ts";
import { isSignalAborted, onSignalAbort } from "./signal-input.ts";
import { PublisherError, refuse, sanitizePublisherError, type MaintenanceDependencies } from "./types.ts";
// eslint-disable-next-line @typescript-eslint/unbound-method -- Native collection/promise methods use explicit Reflect.apply receivers.
const mapEach = Map.prototype.forEach, setEach = Set.prototype.forEach, promiseThen = Promise.prototype.then;
export function cancelled(signal: AbortSignal): boolean {
    try {
        return isSignalAborted(signal);
    }
    catch {
        return refuse("maintenance-input-invalid");
    }
}
export function preflight(signal: AbortSignal): void { if (cancelled(signal))
    refuse("maintenance-cancelled"); }
function method<T extends (...args: never[]) => unknown>(owner: object, operation: T): T {
    if (typeof operation !== "function")
        refuse("maintenance-input-invalid");
    return ((...args: Parameters<T>) => Reflect.apply(operation, owner, args) as ReturnType<T>) as T;
}
function timestamp(value: string): void {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace("Z", ".000Z"))
        refuse("maintenance-input-invalid");
}
/** Copy trusted policy, ports, collection contents and original metadata before any await. */
export function captureMaintenance(adapter: StoreAdapter, dependencies: MaintenanceDependencies): {
    adapter: StoreAdapter;
    dependencies: MaintenanceDependencies;
} {
    const timingSource = dependencies.timing, deadline = timingSource.deadline;
    const timing = { deadline: method(timingSource, deadline) };
    const context = captureContext(dependencies.context), metadataSource = dependencies.metadata;
    const metadata = { timestamp: metadataSource.timestamp }, now = dependencies.now;
    timestamp(metadata.timestamp);
    timestamp(now);
    const sourceStates = dependencies.prStates, sourcePins = dependencies.pins;
    const prStates = new Map<string, "open" | "closed" | "unknown">(), pins = new Set<string>();
    Reflect.apply(mapEach, sourceStates, [(state: "open" | "closed" | "unknown", key: string) => {
            if (prStates.size >= STORE_LIMITS.maxFiles || typeof key !== "string" || !isGitHubId(key) || !["open", "closed", "unknown"].includes(state))
                refuse("maintenance-input-invalid");
            prStates.set(key, state);
        }]);
    if (sourcePins !== undefined)
        Reflect.apply(setEach, sourcePins, [(key: string) => {
                if (pins.size >= STORE_LIMITS.maxFiles || typeof key !== "string" || parseRunKey(key) === undefined)
                    refuse("maintenance-input-invalid");
                pins.add(key);
            }]);
    const signal = dependencies.signal;
    if (signal !== undefined)
        cancelled(signal);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Operations are read once and rebound to their same owners below.
    const read = adapter.read, cas = adapter.cas, delay = dependencies.delay, jitter = dependencies.jitter, checkpoint = dependencies.checkpoint;
    return { adapter: { read: method(adapter, read), cas: method(adapter, cas) }, dependencies: { context, metadata, now, prStates, pins, timing, delay: method(dependencies, delay), jitter: method(dependencies, jitter), ...(signal === undefined ? {} : { signal }), ...(checkpoint === undefined ? {} : { checkpoint: method(dependencies, checkpoint) }) } };
}
/** Own port results within their fulfillment reaction; rejected values never expose fields/prototypes. */
export function fulfilled<T, Owned>(pending: Promise<T>, capture: (value: T) => Owned): Promise<Owned> {
    return new Promise((resolve, reject) => {
        const fail = (error: unknown) => { reject(sanitizePublisherError(error, "maintenance-operation-failed")); };
        try {
            Reflect.apply(promiseThen, pending, [(value: T) => { try {
                    resolve(capture(value));
                }
                catch (error) {
                    fail(error);
                } }, fail]);
        }
        catch (error) {
            fail(error);
        }
    });
}
/** Bound ignored cancellation without permitting cleanup hooks to strand promise settlement. */
export function race<T, Owned>(pending: Promise<T>, signal: AbortSignal, capture: (value: T) => Owned): Promise<Owned> {
    return new Promise((resolve, reject) => {
        let settled = false, remove = () => { };
        const fail = (error: unknown) => {
            if (settled)
                return;
            let safe = sanitizePublisherError(error, "maintenance-operation-failed");
            settled = true;
            try {
                remove();
            }
            catch {
                safe = new PublisherError("maintenance-operation-failed");
            }
            reject(safe);
        };
        const finish = (value: T) => {
            if (settled)
                return;
            let owned: Owned;
            try {
                preflight(signal);
                owned = capture(value);
            }
            catch (error) {
                fail(error);
                return;
            }
            settled = true;
            try {
                remove();
            }
            catch {
                reject(new PublisherError("maintenance-operation-failed"));
                return;
            }
            resolve(owned);
        };
        const abort = () => { fail(new PublisherError("maintenance-cancelled")); };
        try {
            Reflect.apply(promiseThen, pending, [finish, fail]);
            remove = onSignalAbort(signal, abort);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Native listener hooks can synchronously dispatch during registration.
            if (settled)
                remove();
            if (cancelled(signal))
                abort();
        }
        catch (error) {
            fail(error);
        }
    });
}
export function captureReply(reply: CasResult): CasResult {
    try {
        const status = reply.status;
        if (status === "conflict")
            return { status };
        if (status === "accepted") {
            const tip = reply.tip;
            if (typeof tip !== "string")
                refuse("maintenance-cas-invalid");
            checkedTip(tip);
            return { status, tip };
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- A port result is checked at runtime, including values outside its declared union.
        if (status === "unknown") {
            const attemptedTip = reply.attemptedTip;
            if (attemptedTip !== undefined) {
                if (typeof attemptedTip !== "string")
                    refuse("maintenance-cas-invalid");
                checkedTip(attemptedTip);
            }
            return { status, ...(attemptedTip === undefined ? {} : { attemptedTip }) };
        }
        return refuse("maintenance-cas-invalid");
    }
    catch {
        return refuse("maintenance-cas-invalid");
    }
}

/** Copy native collection contents before handing a private DTO to the shared validator. */
export function captureStoreSnapshot(source: StoreSnapshot, repositoryId: string): StoreSnapshot {
    const tip = source.tip, store = source.store, listing = source.files, count = listing.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > STORE_LIMITS.maxFiles)
        refuse("maintenance-input-invalid");
    const files: { path: string; bytes: number }[] = [];
    for (let index = 0; index < count; index++) {
        const file = listing[index] as StoreSnapshot["files"][number] | null;
        if (typeof file !== "object" || file === null)
            refuse("maintenance-input-invalid");
        const path = file.path, bytes = file.bytes;
        if (typeof path !== "string" || !Number.isSafeInteger(bytes) || bytes < 0)
            refuse("maintenance-input-invalid");
        files.push({ path, bytes });
    }
    const sourceRuns = source.runs, runs = new Map<string, Run>();
    Reflect.apply(mapEach, sourceRuns, [(run: Run, key: string) => {
        if (runs.size >= STORE_LIMITS.maxFiles)
            refuse("maintenance-input-invalid");
        runs.set(key, run);
    }]);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The original reader is captured once and invoked with its source receiver.
    const reader = source.readFile;
    if (typeof reader !== "function")
        refuse("maintenance-input-invalid");
    return captureSnapshot({ tip, store, files, runs, readFile: path => Reflect.apply<typeof source, [string], Promise<Uint8Array>>(reader, source, [path]) }, repositoryId);
}
