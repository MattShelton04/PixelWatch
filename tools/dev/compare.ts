// `pixelwatch-dev compare` (M1.8, ADR 0014): local inputs through the publisher's own pipeline.
//
//   readInputs (hostile local tree, lstat-only limits first)
//     → ingestArtifacts (ZIP, bundle.json, identity, files, bounded PNG decode, merge; M1.4)
//     → compareImages on canonical blobs in a PngWorker (comparator-v1, M1.3)
//     → buildAnalysis (results, counts, parts, coverage, claims; M1.5)
//     → the local report (report.ts)
//
// There is no source envelope, so nothing is corroborated and no run@1 is built; the report says
// so. Nothing here reads the environment, the network, Git or GitHub.
import {
  COMPARATOR_V1,
  type Comparison,
  type Ingestion,
  PngWorker,
  blobPath,
  buildAnalysis,
  ingestArtifacts,
  unitKeyString,
} from "../../packages/core/src/index.ts";
import { type Config, type PartIdentity, parseArtifactName, parseDocument, validateDocument } from "../../packages/schemas/src/index.ts";
import { InputError, type ListDir, type LocalPart, type SideSpec, readConfigBytes, readInputs } from "./inputs.ts";
import { type DevReport, type ExpectedFrom, buildReport } from "./report.ts";

export interface CompareOptions {
  /** Absent with --no-baseline: every base side is `none` (01 §4.4, an initial commit). */
  readonly base?: string;
  readonly head: string;
  readonly config?: string;
  /** Tests substitute a listing that permutes the order. */
  readonly list?: ListDir;
  /** Tests share one worker across runs; it is then left open. By default each run has its own. */
  readonly worker?: PngWorker;
}

/** Parts the ingress rejected. Their diagnostics are bounded fixed text (IngressError). */
export class RejectedParts extends Error {
  readonly parts: readonly { name: string; code: string; message: string }[];

  constructor(parts: readonly { name: string; code: string; message: string }[]) {
    super(`${String(parts.length)} parts were rejected`);
    this.name = "RejectedParts";
    this.parts = parts;
  }
}

function identityOf(part: LocalPart): PartIdentity {
  const identity = parseArtifactName(part.name);
  if (identity === undefined) throw new Error("a local part has no artifact name");
  return identity;
}

/**
 * The expected parts when no config is given: every provider the inputs name, with the shard count
 * they name. The config's source fields are required by config@1 but unused by ingestion; nothing
 * here is an envelope and none of it reaches the report.
 */
function derivedConfig(parts: readonly LocalPart[]): Config {
  const shards = new Map<string, number>();
  for (const part of parts) {
    const { providerId, shard } = identityOf(part);
    const known = shards.get(providerId);
    if (known !== undefined && known !== shard.count) {
      throw new InputError("input-shard-conflict", `parts of provider ${providerId} name different shard counts`);
    }
    shards.set(providerId, shard.count);
  }
  const checked = validateDocument("config", {
    schemaVersion: 1,
    source: { workflowIds: ["1"], events: ["push"] },
    providers: [...shards].map(([id, count]) => ({ id, shards: count })),
  });
  if (!checked.ok) throw new InputError("input-too-many-entries", `the parts don't fit config@1 (${checked.issue.code.replace(/[^a-z0-9-]/g, "?")})`);
  return checked.value;
}

async function loadConfig(path: string): Promise<Config> {
  const parsed = parseDocument("config", await readConfigBytes(path));
  if (!parsed.ok) throw new InputError("config-invalid", `<config> is not a valid config@1 (${parsed.issue.code.replace(/[^a-z0-9-]/g, "?")})`);
  return parsed.value;
}

function attemptOf(parts: readonly LocalPart[]): string {
  const attempts = new Set(parts.map((p) => identityOf(p).attempt));
  const [attempt] = attempts;
  if (attempts.size !== 1 || attempt === undefined) throw new InputError("input-mixed-attempts", `the parts name ${String(attempts.size)} different attempts; one comparison never mixes attempts`);
  return attempt;
}

/** Refuses what the publisher would only report: ignored inputs and rejected parts. */
function refuseIncompleteInput(ingestion: Ingestion): void {
  const ignored = ingestion.ignored.length + ingestion.ignoredOverflow;
  if (ignored > 0) {
    const reasons = [...new Set(ingestion.ignored.map((i) => i.reason))].sort().join(", ");
    throw new InputError("input-unexpected-part", `${String(ignored)} parts aren't expected by the config (${reasons})`);
  }
  const rejected = ingestion.parts.filter((p) => p.status === "rejected");
  if (rejected.length > 0) {
    throw new RejectedParts(
      rejected.map((p) => ({
        name: `${p.revision}/${p.providerId}/s${String(p.shard.index)}-of${String(p.shard.count)}`,
        code: p.diagnostic?.code ?? "part-rejected",
        message: p.diagnostic?.message ?? "rejected",
      })),
    );
  }
}

async function comparisonsOf(ingestion: Ingestion, blobs: ReadonlyMap<string, Uint8Array>, worker: PngWorker): Promise<Map<string, Comparison>> {
  const comparisons = new Map<string, Comparison>();
  for (const unit of ingestion.units) {
    if (unit.base.state !== "captured" || unit.head.state !== "captured") continue;
    const blob = (hash: string) => {
      const bytes = blobs.get(blobPath(hash));
      if (bytes === undefined) throw new Error("a captured side has no canonical blob");
      return bytes;
    };
    // Only the canonical blobs the ingress wrote are decoded here, never an uploaded file (ADR 0008).
    const base = await worker.decode(blob(unit.base.pixelHash));
    const head = await worker.decode(blob(unit.head.pixelHash));
    comparisons.set(unitKeyString(unit), await worker.compare(base, head, COMPARATOR_V1));
  }
  return comparisons;
}

export async function compareLocal(options: CompareOptions): Promise<DevReport> {
  const sides: SideSpec[] = [...(options.base === undefined ? [] : [{ revision: "base" as const, root: options.base }]), { revision: "head", root: options.head }];
  const config = options.config === undefined ? undefined : await loadConfig(options.config);
  const parts = await readInputs(sides, options.list);
  const attempt = attemptOf(parts);
  const expectedParts: ExpectedFrom = config === undefined ? "inputs" : "config";
  // Local ordinals: the ingress API wants unique numeric IDs. They never reach the report.
  const artifacts = parts.map((p, i) => ({ artifactName: p.name, artifactId: String(i + 1), zip: p.zip }));
  const blobs = new Map<string, Uint8Array>();
  const pool = {
    has: (path: string) => Promise.resolve(blobs.has(path)),
    add: (path: string, bytes: Uint8Array) => {
      blobs.set(path, bytes);
      return Promise.resolve();
    },
  };
  const worker = options.worker ?? new PngWorker();
  try {
    const ingestion = await ingestArtifacts({
      config: config ?? derivedConfig(parts),
      attempt,
      baseline: options.base === undefined ? "none" : "expected",
      artifacts,
      pool,
      codec: worker,
    });
    refuseIncompleteInput(ingestion);
    const analysis = buildAnalysis(ingestion, await comparisonsOf(ingestion, blobs, worker));
    return buildReport(analysis, ingestion.excluded, expectedParts, options.base === undefined ? "none" : "inputs");
  } finally {
    if (options.worker === undefined) await worker.close();
  }
}
