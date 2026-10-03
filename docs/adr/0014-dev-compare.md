# ADR 0014: The internal `pixelwatch-dev compare`

- Status: proposed (owner decisions inferred; see "Owner decisions inferred" in the M1.8 PR)
- Date: 2026-10-03
- Task / spike: M1.8

## Context

M1.8 is the last M1 task: an internal `pixelwatch-dev compare base/ head/` that "reproduces M1.3
locally; no network or credentials; stable non-zero exit codes and bounded errors" (08 §4). The M1
exit demo needs it to match the prototype's goldens and pass the hostile corpus. 01 §5 allows local
development only through this internal, loopback-only tool, and 06 §2 puts it in `tools/`.

The design leaves these open:

- **Input shape.** What `<base>` and `<head>` are, and how they reach the publisher's bounded
  ingress (M1.4) without a second, looser parser.
- **Output.** What goes to stdout and what to stderr.
- **Exit codes.** Which codes, and how they keep "unknown is never safe" (01 §4.3, R4.3-12).
- **Bounded errors.** What bounds a message, and what it may quote.
- **No envelope.** run@1 and changes@1 both require a corroborated source envelope, which a local
  compare doesn't have. Faking one is not allowed.
- **Expected parts.** Ingestion needs a config@1 to know which parts to expect. A local compare
  may not have one.
- **Location and invocation.**

Building it also found that two of the 48 recorded tiny cases can't be produced by any ingestion
(see "Goldens").

## Decision

### 1. Inputs are directories, and every part goes through `ingestArtifacts`

`<base>` and `<head>` are directories. Each is either:

- **one bundle@1 part**: it holds `bundle.json` and its `<viewId>.<variantId>.png` files (an
  extracted artifact); or
- **a directory of parts**: each child is an extracted artifact directory named
  `<artifact name>/` (what `gh run download` writes) or an archive named `<artifact name>.zip`,
  with the 02 §6 artifact name. A part's name must name the side it's in.

Anything else is refused, never skipped. `--no-baseline <head>` compares a head with no baseline,
like an initial commit (01 §4.4).

Each part directory is packed, file for file, into a stored ZIP (the test-side writer in
`tools/zip-corpus/`), and every part, packed or archived, goes through the same
`ingestArtifacts` as the publisher's artifacts: ZIP profile, entry names, `bundle.json`, identity,
file set, the bounded PNG decoder in a `PngWorker`, canonical blobs and the fixed-part merge. The
local layer adds no validation of its own beyond the file-system rules below, so there is no
second parser. Images are compared from the canonical blobs, as in the publisher.

A bare part directory has no artifact name, so its name is built from the side and the attempt,
provider and shard its `bundle.json` states. That file is read with the same strict parser
(`parseDocument("bundle")`) and the 1 MiB limit, and the ingress still checks the identity
against the name.

### 2. Input directories are hostile

`tools/dev/inputs.ts` is the only code that reads them:

- No link is followed: a symbolic link or junction anywhere (the root included) and a file with
  a second hard link are refused. Files are opened with `O_NOFOLLOW` where the platform has it,
  and `fstat` must show the same device, inode and size the scan saw.
- Only a root, its direct children and a part directory's direct children are read, so nothing
  outside the given roots is reached.
- A first pass uses `lstat` only and enforces the 02 §5 limits for all inputs before any byte is
  read: 4096 entries per directory and across part directories, 1 MiB for `bundle.json` and
  config, 32 MiB per other file, 128 MiB per part, 256 MiB in total, 1024 parts.
- Extra files are refused. Next to parts, anything not named as a part is `input-extra-entry`. In
  a part, a subdirectory is `input-nested-directory`, and any other file is packed and refused by
  the ingress (`zip-name-not-allowed`, `part-extra-file`).
- Residual risk: a process racing the scan with renames can still swap a directory between its
  `lstat` and `opendir`. A local attacker who can do that already controls the inputs. Files are
  re-checked with `fstat` after opening.

### 3. Without a config, the inputs name the expected parts

By default, the expected parts are every provider the inputs' part names mention, with the shard
count they name. A provider whose parts name different counts is `input-shard-conflict`. Coverage
is then relative to what the inputs declare: a provider missing from both sides can't be seen.
`--config <file>` reads an adopter's `config.json` (strict parser, 1 MiB, no links) and expects
exactly its parts. The report states which (`expectedParts: "inputs" | "config"`).

All parts must name one attempt (`input-mixed-attempts`); a comparison never mixes attempts.

### 4. What the publisher would only report, the dev CLI refuses

The publisher keeps a run with a rejected part as explicitly incomplete. Locally, the person
running the tool supplied the bytes and should fix them, so the CLI refuses instead:

- a part the ingress rejects (any part-scope code, duplicates and conflicts included);
- an input the selection ignores (with `--config`, a part the config doesn't expect);
- an ingestion-scope refusal (entry, byte, artifact or unit limits).

Worker crashes, worker timeouts and the 10-minute deadline say nothing about the input (ADR 0008)
and are internal errors.

### 5. Output: a local report on stdout, errors on stderr

stdout carries one document and nothing else, and only for exits 0–2:

- default: the report as canonical JSON (02 §3), with every code unit outside printable ASCII
  written as a `\u` escape, plus one LF. It parses to exactly the canonical document, and no
  label can put a control, bidi or invisible character on the terminal;
- `--summary`: a human summary that names units by ID only and never prints labels, claims or
  any other capture text.

The report (`report: "pixelwatch-dev-compare"`, `reportVersion: 1`) is an internal document, not a
02 §1 contract. It is not served or stored. There is no envelope, so it is neither run@1 nor
changes@1 and has no `runKey` or URLs. It says `source: {kind: "local", corroborated: false}`
and `captureClaimsTrusted: false`, and carries:

- the claims, parts, coverage, counts and results that `buildAnalysis` gives a run;
- `capabilities` by the changes@1 rule (`capabilitiesOf`), so a feature that didn't run is false
  with its fields absent, never an empty array;
- `excluded` (units absent on both sides, ADR 0008);
- `outcome`, `expectedParts` and `baseline`.

The parts carry no `artifactId`, since local inputs have none. To share this code, `buildRun`'s
envelope-free half is now `buildAnalysis` in core, and the changes@1 capability rule is exported
as `capabilitiesOf`. Neither changes any output.

stderr carries bounded error lines, and only for exits 3–5.

### 6. Exit codes

| Code | Outcome | When |
|---|---|---|
| 0 | no differences | Coverage `complete-declared`, no missing part, at least one result, declared = accounted = results, and every result `unchanged` |
| 1 | differences | As for 0, but something is `added`, `removed`, `subtle` or `changed` |
| 2 | incomplete | Anything `missing`, `failed` or `incomparable`, incomplete or unknown coverage, a missing part, or nothing to compare. It wins over 1. |
| 3 | invalid input | An input was refused (§§2–4). Nothing on stdout. |
| 4 | usage | Bad arguments, and also `--help`: help isn't a comparison, so it never exits 0 |
| 5 | internal error | Anything else, including a crash that escapes `main` |

The outcome is computed from the results themselves, not from the counts. Unknown is never safe:
0 comes only from a finished comparison in which every declared unit was captured on both sides
and is unchanged. Added and removed units are differences, not incompleteness: both sides were
accounted for.

### 7. Bounded errors

- Each stderr line is printable ASCII only. A backslash and every other code point are escaped
  (`\\`, `\u{…}`). A line is at most 1024 characters, cut on an escape boundary.
- At most 20 lines. Further rejected parts are counted, not printed.
- Every line has a stable code: `pixelwatch-dev: <kind> [<code>]: <message>`. Ingress codes pass
  through. Local codes are `input-*` and `config-invalid`.
- Messages never echo an input-derived name or label. Roots are `<base>`, `<head>` and
  `<config>`; entries are named by position in name order; only names that already match the
  02 §6 artifact-name pattern are printed. Ingress diagnostics are fixed text already (ADR 0008).
- No stack trace unless `--debug`. Then it's at most 16 escaped lines.

### 8. Location and invocation

- `tools/pixelwatch-dev.ts` is the entry. `tools/dev/` holds `cli.ts` (arguments, streams, exit
  codes), `compare.ts` (the pipeline), `inputs.ts` (the hostile local tree) and `report.ts` (pure:
  outcome, report, summary, escaping). It's run as `node tools/pixelwatch-dev.ts compare …` or
  `pnpm -s dev:compare …`. Without `-s`, pnpm adds its own lines to stderr; the exit code passes
  through either way.
- There's no new dependency and no workspace package. It isn't shipped, and the public CLI is M4.
- It reads no environment variable, imports no network, process or Git module, and makes no Git
  or GitHub calls. Core stays pure: all file and process I/O is in `tools/`.

### 9. Goldens

`tools/dev-compare.test.ts` builds bundle inputs in a temp dir from the committed fixtures and
requires the CLI's results to equal `tiny/expected.json` and `crops/expected.json` exactly.

Two tiny cases, `missing-both` (base `part-missing`, head `unit-missing`) and `missing-over-none`
(no baseline, head `unit-missing`), list the unit on neither side. The declared set is the union of
the valid parts' catalogs (02 §6 step 5), so no ingestion declares such a unit. They exercise
`unitResult`'s precedence, which `packages/core/test/comparator-goldens.test.ts` still covers. The
test reproduces the other 46 exactly and pins that these two are exactly the unlisted ones. This
isn't a comparator delta, and no golden changes.

Full-size parity stays local: `node tools/check-reference-compare.ts --dev-compare` converts the
three recorded captures from `.reference/` and runs them through the CLI
(`docs/evidence/m1.8-dev-compare.md`).

## Consequences

- New: `tools/pixelwatch-dev.ts`, `tools/dev/`, `tools/dev-compare.test.ts`, the
  `--dev-compare` mode of `tools/check-reference-compare.ts`, the `dev:compare` script and
  `docs/evidence/m1.8-dev-compare.md`.
- Core: `buildAnalysis` and `capabilitiesOf` are exported. `buildRun` and `projectChanges` produce
  the same bytes as before, and their tests and goldens are unchanged.
- No schema, contract, served path or GitHub setting changes.
- The threat model gains passing rows for R4.3-07, R4.3-08, R4.3-10, R4.3-11, R4.3-12, R4.6-06,
  R4.6-10 and R4.7-02 on the local path.
- `pixelwatch-dev serve` (loopback viewer) comes with M2.7/M3.
