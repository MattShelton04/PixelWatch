import assert from "node:assert/strict";
import { API, FakeGitHub, SIGNED_URL, download } from "../github.ts";
import { Capture, assertNoSecrets } from "../capture.ts";
import { Clock } from "../schedule.ts";
import { bounded, spec, type Scenario } from "./spec.ts";

// Runnable transport probe only. No claim about envelope verification/forge/publisher behavior.
export function probeGitHubFaults(): void {
  for (const status of [410, 429, 403, 500, 502, 503]) {
    const fake = new FakeGitHub(); const clock = new Clock(); const capture = new Capture();
    const url = `${API}/repos/sim/upstream/actions/artifacts/201/zip`;
    const reply = status === 403 || status === 429 ? { status, headers: { "retry-after": "2" } } : { status };
    fake.route({ method: "GET", url }, status === 410 ? [reply] : [reply, reply, reply]);
    const result = download(fake, url, clock, capture);
    assert.equal(result.kind, "missing");
    assert.equal(fake.calls.length, status === 410 ? 1 : 3);
    assert.equal(clock.now, 946684800000 + (status === 410 ? 0 : status === 403 || status === 429 ? 4000 : 2000));
    fake.assertConsumed(); capture.assertClean();
  }
  const fake = new FakeGitHub(); const capture = new Capture();
  const url = `${API}/repos/sim/upstream/actions/artifacts/201/zip`;
  fake.route({ method: "GET", url }, [{ status: 302, headers: { location: SIGNED_URL } }]);
  fake.route({ method: "GET", url: SIGNED_URL }, [{ status: 200, body: new Uint8Array([1, 2]) }]);
  assert.equal(download(fake, url, new Clock(), capture).kind, "downloaded");
  assert.deepEqual(fake.calls.map((c) => c.authorized), [true, false]);
  fake.assertConsumed(); capture.assertClean(); assertNoSecrets([JSON.stringify(fake.calls)]);
}
export default {
  id: "sim-github-faults",
  cases: [spec("expiry-rate-limit-redirect-and-server-errors", ["M2.1", "M2.3"], "github-redirect", "fail-before",
    "Pass expired listing/410, rate-limit and 5xx fixtures plus a signed cross-origin 302 through production forge and ingest; capture all output and stored bytes.", (e) => {
      bounded(e); assert.deepEqual(e.authorization, [true, false]);
      assert.equal(e.coverage, "incomplete"); assert.ok(e.logs); assertNoSecrets(e.logs);
    })],
} satisfies Scenario;
