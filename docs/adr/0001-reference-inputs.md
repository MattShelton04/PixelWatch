# ADR 0001: Reference inputs from the prototypes

- Status: accepted
- Date: 2026-09-30
- Task / spike: 08 §1 item 3 (before M0.3 / M0.6)

## Context

PixelWatch extracts what two of the owner's prototypes built separately (00-README). M0.3
(converters) and M0.6 (comparator ADR and goldens) have to be derived from the real prototype
code and real capture output, not from the design docs' descriptions of them. This ADR pins
exactly which inputs were used, so later goldens and converters can be reproduced.

Everything below is fetched into the git-ignored `.reference/` folder. Nothing from it is
committed.

### Repositories

| Prototype | URL | Commit used (`main` HEAD, 2026-09-30) | `gh-pages` tip | Repo licence |
|---|---|---|---|---|
| PropertyScope | https://github.com/MattShelton04/41026ASDProject | `6378d8be5b1f418f72279e04b3de23d761b426d3` | `8f9435fdcb4e04e14285930381cb6b64732e61e3` | none declared |
| TracePilot | https://github.com/MattShelton04/TracePilot | `067cfcde85581920d358699c7f6d37b6a6caea2d` | `2f21af1bb59b4f8d0e27615b129cdfc607931f78` | GPL-3.0 |

Paths of interest: `scripts/visual/`, `.github/workflows/visual-capture.yml` and
`.github/workflows/visual-report.yml`, and the `gh-pages` branch (history format for M3.5).

### Capture artifacts

PropertyScope **Visual Capture run 36405830015**, attempt 1, event `pull_request` (PR #123),
conclusion `success`, created 2026-09-28T09:48:30Z. That run's commits:

- PR head `8fc85c2df34f454d8eac5aa525a3398f45ef6bd5`;
- base (merge base) `a2c66ece818dc2eb43d258aaec8ea1fc569fb0da`;
- harness (synthetic merge commit) `8eb1e7956dbc0a1001536ab3304b15be4ff07838`.

The run hadn't expired, so no fallback run was needed.

| Artifact ID | Name | Bytes (zip) | SHA-256 of zip (matches the API `digest`) | Expires |
|---|---|---|---|---|
| 10962062704 | `visual-base-fixture` | 5730731 | `b062b6a961b6c98dc663645e870b0671efac82122b192fa5cd2367d308e775a5` | 2026-10-12T09:49:53Z |
| 10962640673 | `visual-base-stack` | 2621094 | `b6a7b4c7ceb3f8f5f9eb5da88c62d3d4c111197ccd8c3b3855a73d3cd885aad4` | 2026-10-12T09:50:42Z |
| 10962785105 | `visual-head-fixture` | 5730724 | `1f382cc54aa35181c87237cc24ca0387e4016b311a41f1574ccc9346feb9dfa5` | 2026-10-12T09:50:01Z |
| 10962835047 | `visual-head-stack` | 2621096 | `e711eb3ebdcd710f732b5194cf8bd58227748e7b4fb87d5a695d5e52b914fdc5` | 2026-10-12T09:50:39Z |

Commands used:

```sh
gh repo clone MattShelton04/41026ASDProject .reference/propertyscope
gh repo clone MattShelton04/TracePilot      .reference/tracepilot
gh run download 36405830015 -R MattShelton04/41026ASDProject -D .reference/artifacts/ps-36405830015
gh api repos/MattShelton04/41026ASDProject/actions/artifacts/<id>/zip > .reference/artifacts/ps-36405830015-zips/<name>.zip
```

Observed contents: each revision has 42 captured views (29 `fixture` + 13 `stack`), all with
status `captured`. They're 1440 px wide and 1000–6000 px tall (median 1076). The median PNG is
≈ 170 KB, and each revision totals 8.96 MB. This agrees with 00-README §6.

**The artifacts expire on 2026-10-12.** After that, the only copies are the ones in `.reference/`
and any backup the owner keeps. M0.3 and M0.6 should record whatever they derive from them
(converted bundles, goldens) before then, or keep a checksummed backup that the 07 §3 download
script can point at.

### Licensing and provenance

- The owner of both repositories approved reusing their code in PixelWatch under Apache-2.0
  (08 §8 item 1; reconfirmed in the M0.1/M0.2 kickoff, 2026-09-30).
- TracePilot is published under GPL-3.0, and PropertyScope has no licence. PropertyScope is a
  shared university project with other contributors. Per the GitHub commit history on
  2026-09-30, every commit to `scripts/visual/` and to `visual-capture.yml` /
  `visual-report.yml` in **both** repositories is authored by the owner (`MattShelton04`). The
  owner can therefore relicense that code.
- **Scope of reuse:** only those paths. Code from elsewhere in either repository (other
  contributors, or TracePilot code under GPL-3.0 not authored by the owner) must not be copied
  without a new ADR.

## Decision

- Use exactly the commits and artifacts above as the reference inputs for M0.3 and M0.6. Any
  later refresh, for example a newer capture run, gets a new ADR that supersedes this one, or an
  amendment listing the new IDs.
- Reused or ported code gets a short provenance comment naming the source repo, path and commit
  above.

## Consequences

- `.reference/` is git-ignored. Tests must never read from it. Fixtures derived from it are
  committed under `testdata/` with their own checksums (07 §3).
- Goldens for M0.6 are produced by running PropertyScope's comparator at `6378d8be…` on these
  four artifacts.
- No change to `docs/design/` from this ADR. The discrepancies found while reading the prototypes
  are reported to the owner separately for a decision.

## Addendum (2026-09-30, M0.3)

**Additional reference input.** TracePilot **Desktop Visual Capture run 36314265418**, attempt 1,
event `push` to `main`, conclusion `success`, created 2026-09-27T10:59:11Z. Head
`067cfcde85581920d358699c7f6d37b6a6caea2d` (the commit above); base
`77616caaaf779218ba888e2bd7aa98a6bbac260f`. Downloaded to `.reference/artifacts/tp-36314265418/`.

| Artifact ID | Name | Bytes (zip) | SHA-256 of zip (API `digest`) | Expires |
|---|---|---|---|---|
| 10930455724 | `visual-base-1` | 8522811 | `0f5b176f4bcf12892ef669de8a3f2e0933024964ee77261fc7752240af857b28` | 2026-10-11T11:01:42Z |
| 10929892843 | `visual-base-2` | 8173135 | `7f051f1e4690c17a295635fb1b36b1695ae49fb458f6944bec9edc79a8eec8e8` | 2026-10-11T11:01:14Z |
| 10930017524 | `visual-head-1` | 8522792 | `1df3f7bd13ea86264c4cd17c01301bab32acb54a7e72348a2cf1006155ea21c1` | 2026-10-11T11:01:14Z |
| 10930027495 | `visual-head-2` | 8173111 | `cd3efb1954c655d0c9352b5c9fde86a9b0d6346c9bb3217d3841902ab366124f` | 2026-10-11T11:01:27Z |

Each revision has 105 views (53 + 52 over two shards), all `captured`.

**Reference inputs are examples, not a standard (owner, 2026-09-30).** Prototype output shows
what real input looks like. It doesn't define correct output. So:

- `testdata/prototypes/` commits a few verbatim manifests and one real screenshot per prototype
  (provenance in its README). Tests check properties of the conversion (valid, counts add up,
  one unit per case, correct names), not byte-exact converted bundles.
- There are no committed checksums or download script for these inputs. The Consequences
  sentence above about "their own checksums (07 §3)" doesn't apply to them.
- The M0.6 plan to record comparator goldens from running PropertyScope's code is unchanged by
  this addendum. Whether those goldens are binding is for the owner to decide at M0.6. (Decided:
  binding, with listed deltas; see the M0.6 addendum and `docs/adr/comparator-v1.md`.)

## Addendum (2026-09-30, M0.6)

**PR #123 has no visual changes.** All 42 base/head PNGs of run 36405830015 are byte-identical,
and so are those of TracePilot run 36314265418. PropertyScope has only three Visual Capture runs,
all from the same tooling PR and its merge. Running the comparator on them proves only
"identical in, unchanged out". PR #123 stays recorded as that case.

**Additional reference inputs with real changes (owner, 2026-09-30).** These are two TracePilot
Desktop Visual Capture runs that TracePilot's own `gh-pages` history
(`2f21af1bb59b4f8d0e27615b129cdfc607931f78`) reports as changed. PropertyScope's comparator runs
on their screenshots, which are 1440×960 RGB and inside its PNG profile.

| Run | Attempt / event | Head | Base (manifest claim) | Created |
|---|---|---|---|---|
| 36287837535 | 1 / `push` to `main` | `3507148c340e89da29358e7f0751214bffc1d102` | `53d3cdcdd9cb70b66842fd47d43238dd12a773df` | 2026-09-27T02:12:21Z |
| 36301239732 | 1 / `pull_request` (Dependabot) | `7e8380a52d84c39c28c4ffa3a66f3ffcdb9c17cf` | `e3ff0935641de98b96da49f9c2c9fb5b83e3cbf1` | 2026-09-27T06:49:37Z |

| Run | Artifact ID | Name | Bytes (zip) | SHA-256 of zip (API `digest`) | Expires |
|---|---|---|---|---|---|
| 36287837535 | 10921730284 | `visual-base-1` | 5398422 | `bc65a6a8c9bb8928c773f6d68eecc33d3ef52a141d07274b73bdf70cc6d6bfec` | 2026-10-11T02:14:08Z |
| 36287837535 | 10921521173 | `visual-base-2` | 5393579 | `84b3e4626d5b3cf36b1bf36cf566d61982b2db3cfea1fb5f89599ec18a65ba96` | 2026-10-11T02:14:02Z |
| 36287837535 | 10921240812 | `visual-head-1` | 5398486 | `647368600e344c58e966ba9aeacd2f3d20142de701cc8517d574403dba67a30b` | 2026-10-11T02:14:05Z |
| 36287837535 | 10921760211 | `visual-head-2` | 5393559 | `44e8d95c18f7a1a885f6af743a65f17a3820d8f8e265c341435c25a3ffc378b8` | 2026-10-11T02:13:56Z |
| 36301239732 | 10925303368 | `visual-base-1` | 8165992 | `4af0538fb89be283c94edb1d42066314c50e9739889989d73b3b6d0c36d71831` | 2026-10-11T06:51:53Z |
| 36301239732 | 10926230874 | `visual-base-2` | 7927547 | `33e3f7e265f1a2b8f086ef6b09e357c921391605ff90bee4a37a0005ce8cefbb` | 2026-10-11T06:51:51Z |
| 36301239732 | 10925333267 | `visual-head-1` | 8165610 | `bd3b9f4ea664a2500ca5f3d16977289e9a6c8995f2df2202fc51dd286b0012fe` | 2026-10-11T06:52:09Z |
| 36301239732 | 10926195393 | `visual-head-2` | 7926258 | `3f6adb26fd1764bee04ac3dd71dc8ceb556db1ff1874cf427180996f2c7824d2` | 2026-10-11T06:51:52Z |

These were downloaded with `gh api repos/MattShelton04/TracePilot/actions/artifacts/<id>/zip` into
`.reference/artifacts/tp-<run>-zips/`, and every digest matched.

- Unlike the M0.3 inputs, these **are** checksummed in the committed recordings, because
  comparator-v1 makes their outputs binding. There's still no download script, and they expire on
  2026-10-11.
- Three real crops (1440×256 bands of changed/subtle views) are committed under
  `testdata/comparator/crops/`, so real-pixel parity survives expiry.
- The crops are screenshots of the owner's TracePilot repository, with the same provenance as
  the TracePilot screenshot committed in M0.3 (`testdata/prototypes/`).
