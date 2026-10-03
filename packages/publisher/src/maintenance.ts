import { canonicalBytes } from "@pixelwatch/schemas";
import { planHousekeeping, retentionPolicy, sizeLimits } from "@pixelwatch/core";
import { type StoreAdapter, type StoreCandidate, type StoreSnapshot } from "@pixelwatch/store";
import { checkImmutable, copyCandidate, matchesCandidate, validateTree } from "./admission-input.ts";
import { copyBytes } from "./assembly-input.ts";
import { cancelled as controllerAborted, captureMaintenance, captureReply, captureStoreSnapshot, fulfilled, preflight, race } from "./maintenance-input.ts";
import { onSignalAbort } from "./signal-input.ts";
import { measureSite } from "./sizing.ts";
import { PublisherError, refuse, sanitizePublisherError, type MaintenanceDependencies, type MaintenanceResult } from "./types.ts";
interface ReadView {
    readonly snapshot: StoreSnapshot;
    readonly bytes: ReadonlyMap<string, Uint8Array>;
}
/** Trusted workflow_dispatch retention/GC only; no capture, deployment or arbitrary mutation plan. */
export async function maintainStore(adapter: StoreAdapter, dependencies: MaintenanceDependencies): Promise<MaintenanceResult> {
    const controller = new AbortController(), unlink: (() => void)[] = [];
    let dispose: (() => void) | undefined, proven: MaintenanceResult | undefined;
    const signal = controller.signal;
    try {
        const captured = captureMaintenance(adapter, dependencies), deps = captured.dependencies, ports = captured.adapter;
        try {
            const deadline = deps.timing.deadline(600000);
            // eslint-disable-next-line @typescript-eslint/unbound-method -- The captured disposer keeps the same deadline receiver.
            const operation = deadline.dispose;
            if (typeof operation !== "function")
                refuse("maintenance-timing-invalid");
            dispose = () => { Reflect.apply(operation, deadline, []); };
            const deadlineSignal = deadline.signal;
            for (const source of deps.signal === undefined ? [deadlineSignal] : [deadlineSignal, deps.signal]) {
                if (controllerAborted(source))
                    controller.abort();
                else {
                    unlink.push(onSignalAbort(source, () => { controller.abort(); }));
                    if (controllerAborted(source))
                        controller.abort();
                }
            }
        }
        catch {
            controller.abort();
            refuse("maintenance-timing-invalid");
        }
        const repositoryId = deps.context.repository.repositoryId, policy = retentionPolicy(deps.context.config), limits = sizeLimits(deps.context.config);
        const readView = async (recovery = false): Promise<ReadView> => {
            const pending = ports.read();
            const ownSnapshot = (value: StoreSnapshot) => captureStoreSnapshot(value, repositoryId);
            const snapshot = await (recovery ? fulfilled(pending, ownSnapshot) : race(pending, signal, ownSnapshot));
            const bytes = new Map<string, Uint8Array>();
            for (const file of snapshot.files) {
                const read = snapshot.readFile(file.path), copy = (value: Uint8Array) => copyBytes(value, file.bytes, file.bytes);
                bytes.set(file.path, await (recovery ? fulfilled(read, copy) : race(read, signal, copy)));
            }
            if (snapshot.tip !== null)
                validateTree({ store: snapshot.store, runs: snapshot.runs, files: bytes, metadata: deps.metadata }, repositoryId);
            return { snapshot, bytes };
        };
        const check = async (event: Parameters<NonNullable<MaintenanceDependencies["checkpoint"]>>[0]) => {
            if (deps.checkpoint !== undefined)
                await race(Promise.resolve(deps.checkpoint(event)), signal, () => undefined);
        };
        let prior: ReadView | undefined, unknownPushes = 0;
        for (let attempt = 1; attempt <= 5; attempt++) {
            preflight(signal);
            const current = prior ?? await readView();
            prior = undefined;
            const snapshot = current.snapshot;
            await check({ point: "after-read", attempt, tip: snapshot.tip });
            preflight(signal);
            const observation = (status: "absent" | "unchanged"): MaintenanceResult => ({ status, tip: snapshot.tip, attempts: attempt, unknownPushes, deleted: [], removedRuns: [] });
            if (snapshot.tip === null)
                return observation("absent");
            const tree = { store: snapshot.store, runs: snapshot.runs, files: snapshot.files };
            const projected = measureSite({ ...deps.context, tree });
            const plan = planHousekeeping({ ...tree, policy, limits, now: deps.now, prStates: deps.prStates, pins: deps.pins, projected });
            if (!plan.ok)
                refuse("maintenance-budget-refused");
            if (!plan.gc.changed)
                return observation("unchanged");
            const removed = new Set(plan.gc.delete.map(file => file.path)), kept = new Set(plan.gc.store.runs.map(run => run.runKey));
            const files = new Map([...current.bytes].filter(([path]) => !removed.has(path)));
            files.set("store.json", canonicalBytes(plan.gc.store));
            const candidate: StoreCandidate = { store: plan.gc.store, runs: new Map([...snapshot.runs].filter(([key]) => kept.has(key))), files, metadata: deps.metadata };
            validateTree(candidate, repositoryId);
            checkImmutable(current.bytes, candidate);
            if (plan.gc.delete.length !== current.bytes.size - files.size || plan.gc.removedRuns.some(key => kept.has(key)))
                refuse("maintenance-plan-invalid");
            await check({ point: "before-cas", attempt, tip: snapshot.tip });
            preflight(signal);
            // Sending the push owns its bounded outcome/recovery even if the source scope expires.
            const reply = await fulfilled(ports.cas(snapshot.tip, copyCandidate(candidate)), captureReply);
            let checkpointFailed = false;
            try {
                await check({ point: "after-cas", attempt, tip: snapshot.tip, result: reply.status });
            }
            catch {
                checkpointFailed = true;
            }
            const complete = (status: "updated" | "recovered", tip: string): MaintenanceResult => ({ status, tip, attempts: attempt, unknownPushes, deleted: plan.gc.delete.map(file => ({ ...file })), removedRuns: [...plan.gc.removedRuns], ...(checkpointFailed ? { warnings: ["checkpoint-failed"] } : {}) });
            if (reply.status === "accepted") {
                proven = complete("updated", reply.tip);
                return proven;
            }
            if (reply.status === "unknown") {
                unknownPushes++;
                prior = await readView(true);
                try {
                    await check({ point: "after-unknown-read", attempt, tip: prior.snapshot.tip });
                }
                catch {
                    checkpointFailed = true;
                }
                if (reply.attemptedTip !== undefined && prior.snapshot.tip === reply.attemptedTip && matchesCandidate(prior.snapshot, prior.bytes, candidate)) {
                    proven = complete("recovered", reply.attemptedTip);
                    return proven;
                }
            }
            if (checkpointFailed) {
                if (reply.status === "conflict") await readView(true);
                refuse("maintenance-checkpoint-failed");
            }
            preflight(signal);
            if (attempt < 5) {
                const jitter = deps.jitter(attempt);
                if (!Number.isInteger(jitter) || jitter < 0 || jitter > 1000)
                    refuse("maintenance-input-invalid");
                await race(deps.delay(100 * 2 ** (attempt - 1) + jitter), signal, () => undefined);
            }
        }
        return refuse("maintenance-lease-exhausted");
    }
    catch (error) {
        throw sanitizePublisherError(error, "maintenance-operation-failed");
    }
    finally {
        let failed = false;
        for (const remove of unlink) {
            try {
                remove();
            }
            catch {
                failed = true;
            }
        }
        if (dispose !== undefined) {
            try {
                dispose();
            }
            catch {
                failed = true;
            }
        }
        if (failed) {
            if (proven === undefined)
                // eslint-disable-next-line no-unsafe-finally -- An unconfirmed observational result must refuse when its acquired resource cleanup failed.
                throw new PublisherError("maintenance-timing-invalid");
            (proven as {
                warnings?: readonly ("checkpoint-failed" | "timing-disposal-failed")[];
            }).warnings = [...(proven.warnings ?? []), "timing-disposal-failed"];
        }
    }
}
