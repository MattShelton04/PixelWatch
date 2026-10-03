// Ingestion (M1.4; 02 §§5–6; ADR 0008): the API-listed artifacts of one authenticated source
// attempt → validated parts → merged side states and coverage. Pure apart from the injected blob
// pool and codec: no network, credentials or file I/O.
//
//   select (names only) → per part: ZIP, bundle.json, identity, files, images → merge
//
// A part-scope IngressError rejects that part and the run continues, explicitly incomplete. An
// ingestion-scope error (or any other error) propagates: the ingestion is refused, never
// published as a partial pass (02 §5 "Work").
import { IN_PROCESS_CODEC } from "../blob-pool.ts";
import { IngressError } from "./errors.ts";
import { INGEST_LIMITS, IngestBudget } from "./limits.ts";
import { mergeParts } from "./merge.ts";
import { admitPart, preparePart, type PreparedPart } from "./part.ts";
import { selectArtifacts, type SelectedPart } from "./select.ts";
import type { ArtifactInput, IngestInput, Ingestion, RejectedPart, ValidPart } from "./types.ts";

export async function ingestArtifacts(input: IngestInput): Promise<Ingestion> {
  const deadline = input.deadline ?? AbortSignal.timeout(INGEST_LIMITS.timeoutMs);
  const signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
  const listing = input.listedArtifacts;
  const selection = selectArtifacts({ ...input, artifacts: listing ?? input.artifacts });
  let selected: readonly SelectedPart[];
  if (listing === undefined) {
    selected = selection.selected as readonly SelectedPart[];
  } else {
    if (input.artifacts.length > INGEST_LIMITS.maxArtifacts) throw new IngressError("ingest-too-many-artifacts", "too many downloaded artifacts");
    const expected = new Map(selection.selected.map(part => [part.artifact.artifactId, part]));
    const downloaded = new Map<string, ArtifactInput>();
    // Complete metadata validation precedes every ZIP byte read or pixel/blob operation.
    for (const artifact of input.artifacts) {
      const descriptor = expected.get(artifact.artifactId);
      if (descriptor === undefined || descriptor.artifact.artifactName !== artifact.artifactName || downloaded.has(artifact.artifactId)) {
        throw new IngressError("ingest-selection-invalid", "downloaded artifact does not match a unique selected API descriptor");
      }
      downloaded.set(artifact.artifactId, artifact);
    }
    selected = selection.selected.flatMap(part => {
      const artifact = downloaded.get(part.artifact.artifactId);
      return artifact === undefined ? [] : [{ key: part.key, artifact }];
    });
  }
  const budget = new IngestBudget();
  budget.addCompressed(selected.reduce((sum, p) => sum + p.artifact.zip.byteLength, 0));

  const valid: ValidPart[] = [];
  const rejected: RejectedPart[] = selection.duplicates.map((d) => ({
    ...d.key,
    artifacts: d.artifacts.map((a) => ({ artifactId: a.artifactId })),
    diagnostic: { code: "part-duplicate", message: `${String(d.artifacts.length)} artifacts carry this part's name; none is chosen` },
  }));
  const ctx = { config: input.config, attempt: input.attempt, budget, pool: input.pool, codec: input.codec ?? IN_PROCESS_CODEC, signal };
  const prepared: PreparedPart[] = [];
  for (const part of selected) {
    const artifact = { artifactId: part.artifact.artifactId };
    try {
      prepared.push(await preparePart(part, artifact, ctx));
    } catch (error) {
      if (!(error instanceof IngressError) || error.scope === "ingestion") throw error;
      rejected.push({ ...part.key, artifacts: [artifact], diagnostic: { code: error.code, message: error.detail } });
    }
  }
  for (const part of prepared) {
    try {
      valid.push(await admitPart(part, ctx));
    } catch (error) {
      if (!(error instanceof IngressError) || error.scope === "ingestion") throw error;
      rejected.push({ ...part.part.key, artifacts: [part.artifact], diagnostic: { code: error.code, message: error.detail } });
    }
  }
  if (signal.aborted) throw new IngressError("ingest-aborted", "ingestion cancelled");
  const merged = mergeParts({ config: input.config, baseline: input.baseline, valid, rejected });
  return { attempt: input.attempt, ...merged, ignored: selection.ignored, ignoredOverflow: selection.ignoredOverflow };
}
