import { parseDocument } from "@pixelwatch/schemas";
import { sanitizeForgeError, type HttpResponse } from "@pixelwatch/forge-github";
import { copyBytes, JSON_BYTES } from "./assembly-input.ts";
import { captureReadiness, isAborted, onAbort, pointerMatches, sha256, siteMatches, type CapturedReadiness, type ExpectedBody } from "./readiness-input.ts";
import { refuse, sanitizePublisherError, type ReadinessDependencies, type ReadinessInput, type ReadinessPoll, type ReadinessPollCode, type ReadinessResult } from "./types.ts";

const OVERALL_MS = 600_000;
const REQUEST_MS = 60_000;
const SPACING_MS = 10_000;
const MAX_POLLS = 61;
interface Scope {readonly signal: AbortSignal; close(): void}
type RaceReply<T> = {kind: "value"; value: T} | {kind: "aborted"} | {kind: "failed"; error: unknown};
/** Native signals only, with listener methods immune to supplied object properties. */
function scope(signals: readonly AbortSignal[]): Scope {
  const controller = new AbortController(); const removers: (() => void)[] = [];
  const close = () => {
    let failed = false;
    for (const remove of removers) {try {remove();} catch {failed = true;}}
    if (failed) refuse("readiness-operation-failed");
  };
  try {
    for (const signal of signals) {
      const aborted = () => {controller.abort();};
      removers.push(onAbort(signal, aborted));
      if (isAborted(signal)) controller.abort();
    }
    return {signal: controller.signal, close};
  } catch (error) {
    try {close();} catch { /* All registered listeners were attempted; the original refusal stays fixed. */ }
    throw sanitizePublisherError(error, "readiness-operation-failed");
  }
}
/** The callback's value is captured synchronously before it can cross another await. */
function race<T, R>(operation: () => Promise<T>, signal: AbortSignal, capture: (value: T) => R): Promise<RaceReply<R>> {
  return new Promise(resolve => {
    const state = {settled: false};
    const finish = (reply: RaceReply<R>) => {
      if (state.settled) return;
      state.settled = true;
      try {remove();} catch (error) {resolve({kind: "failed", error}); return;}
      resolve(reply);
    };
    const aborted = () => {finish({kind: "aborted"});};
    const remove = onAbort(signal, aborted);
    if (isAborted(signal)) {aborted(); return;}
    const value = (owned: R) => {finish({kind: "value", value: owned});};
    // The foreign value remains private until the caller reconstructs a fixed diagnostic.
    const failed = (error: unknown) => {finish({kind: "failed", error});};
    try {
      const pending = operation();
      void Promise.resolve(pending).then(supplied => {
        if (state.settled) return;
        try {value(capture(supplied));} catch (error) {failed(error);}
      }, (error: unknown) => {failed(error);});
    } catch (error) {failed(error);}
  });
}
function deadline(captured: CapturedReadiness, milliseconds: number) {
  const handle = captured.deadline(milliseconds);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply invokes this captured disposal port on its own original handle.
  const dispose = handle.dispose;
  if (typeof dispose !== "function") refuse("readiness-operation-failed");
  const close = () => {Reflect.apply<typeof handle, [], ReturnType<typeof dispose>>(dispose, handle, []);};
  try {
    const signal = handle.signal; isAborted(signal);
    return {signal, dispose: close};
  } catch (error) {
    close();
    throw sanitizePublisherError(error, "readiness-operation-failed");
  }
}
function responseCode(response: HttpResponse, expected: ExpectedBody, captured: CapturedReadiness): ReadinessPollCode {
  try {
    const status = response.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) return "transport-failed";
    if (status >= 300 && status < 400) return "redirect-refused";
    if (status !== 200) return "http-status";
    const supplied = response.body;
    let bytes: Uint8Array;
    try {bytes = copyBytes(supplied, JSON_BYTES);}
    catch (error) {return sanitizePublisherError(error, "readiness-operation-failed").code === "byte-array-limit" ? "body-limit" : "transport-failed";}
    if (expected.kind === "site") {
      const parsed = parseDocument("site", bytes);
      if (!parsed.ok) return parsed.issue.code === "unsupported-version" ? "unsupported-version" : "json-invalid";
      if (!siteMatches(parsed.value, captured)) return "identity-mismatch";
      if (parsed.value.generation !== captured.generation) return "generation-mismatch";
    } else {
      const parsed = parseDocument("pr-pointer", bytes);
      if (!parsed.ok) return parsed.issue.code === "unsupported-version" ? "unsupported-version" : "json-invalid";
      if (parsed.value.generation !== captured.generation) return "generation-mismatch";
      if (expected.target === undefined || !pointerMatches(parsed.value, expected.target)) return "pointer-mismatch";
    }
    return sha256(bytes) === expected.sha256 ? "matched" : "digest-mismatch";
  } catch {return "transport-failed";}
}
/** Observations only: no deployment conclusion or comment claim enters this result. */
export async function waitForReadiness(input: ReadinessInput, dependencies: ReadinessDependencies): Promise<ReadinessResult> {
  try {
    const captured = captureReadiness(input, dependencies);
    let previous = -Infinity;
    const now = (): number => {
      const value = captured.now();
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value < previous) refuse("readiness-timing-invalid");
      previous = value; return value;
    };
    const started = now(); const polls: ReadinessPoll[] = []; let consecutivePasses = 0;
    const overallState: {signal?: AbortSignal} = {};
    const result = (requested: ReadinessResult["reason"]): ReadinessResult => {
      // One final sample determines both elapsed time and eligibility. Sampling itself may
      // advance the injected deadline or cancel the caller, so inspect signals afterwards.
      const elapsedMilliseconds = now() - started;
      const reason = captured.signal !== undefined && isAborted(captured.signal) ? "cancelled"
        : (overallState.signal !== undefined && isAborted(overallState.signal)) || elapsedMilliseconds >= OVERALL_MS ? "timeout" : requested;
      return {status: reason === "ready" ? "served" : "pending", reason, generation: captured.generation,
        pollCount: polls.length, consecutivePasses, elapsedMilliseconds,
        polls: Object.freeze(polls.map(poll => Object.freeze({...poll})))};
    };
    if (captured.signal !== undefined && isAborted(captured.signal)) return result("cancelled");
    const overall = deadline(captured, OVERALL_MS);
    overallState.signal = overall.signal;
    try {
      const parent = scope(captured.signal === undefined ? [overall.signal] : [overall.signal, captured.signal]);
      const stopped = (): "cancelled" | "timeout" | undefined => {
        if (captured.signal !== undefined && isAborted(captured.signal)) return "cancelled";
        if (isAborted(parent.signal) || now() - started >= OVERALL_MS) return "timeout";
        return undefined;
      };
      try {
        for (let poll = 1; poll <= MAX_POLLS; poll++) {
          const before = stopped(); if (before !== undefined) return result(before);
          const pollStarted = now(); let code: ReadinessPollCode = "matched";
          for (const expected of captured.expected) {
            const remaining = OVERALL_MS - (now() - started);
            if (remaining <= 0 || isAborted(parent.signal)) {code = "request-timeout"; break;}
            const requestDeadline = deadline(captured, Math.min(REQUEST_MS, remaining));
            try {
              const requestScope = scope([parent.signal, requestDeadline.signal]);
              try {
                try {
                  const request = Object.freeze({method: "GET" as const, url: expected.url,
                    headers: Object.freeze({accept: "application/json", "cache-control": "no-cache"}), maxBytes: JSON_BYTES, signal: requestScope.signal});
                  const reply = await race(() => captured.request(request), requestScope.signal, value => responseCode(value, expected, captured));
                  code = reply.kind === "aborted" ? "request-timeout" : reply.kind === "failed"
                    ? sanitizeForgeError(reply.error, "request-failed").code === "response-too-large" ? "body-limit" : "transport-failed" : reply.value;
                } catch (error) {
                  code = isAborted(requestScope.signal) ? "request-timeout"
                    : sanitizeForgeError(error, "request-failed").code === "response-too-large" ? "body-limit" : "transport-failed";
                }
              } finally {requestScope.close();}
            } finally {requestDeadline.dispose();}
            if (code !== "matched") break;
          }
          const finished = now();
          const after = stopped();
          if (after !== undefined && code === "matched") code = "request-timeout";
          const passed = code === "matched"; consecutivePasses = passed ? consecutivePasses + 1 : 0;
          const record: ReadinessPoll = Object.freeze({poll, startedMilliseconds: pollStarted - started, finishedMilliseconds: finished - started, passed, code});
          polls.push(record);
          if (captured.checkpoint !== undefined && !isAborted(parent.signal)) {
            const copied = Object.freeze({...record});
            const checked = await race(() => captured.checkpoint?.(copied) ?? Promise.resolve(), parent.signal, () => undefined);
            if (checked.kind === "failed") throw sanitizePublisherError(checked.error, "readiness-operation-failed");
          }
          const pending = stopped(); if (pending !== undefined) return result(pending);
          if (consecutivePasses === 3) return result("ready");
          if (poll === MAX_POLLS) return result("timeout");
          const delayed = await race(() => captured.delay(SPACING_MS, parent.signal), parent.signal, () => undefined);
          if (delayed.kind === "failed") throw sanitizePublisherError(delayed.error, "readiness-operation-failed");
          const ended = stopped(); if (delayed.kind === "aborted" || ended !== undefined) return result(ended ?? "timeout");
          if (now() - finished < SPACING_MS) refuse("readiness-timing-invalid");
        }
        return result("timeout");
      } finally {parent.close();}
    } finally {overall.dispose();}
  } catch (error) {throw sanitizePublisherError(error, "readiness-operation-failed");}
}
