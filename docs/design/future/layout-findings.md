# Future · Layout findings: scoped design and evidence limits

**M4:** a few cheap opt-in advisory probes with the capture runner. **M6:** advanced layout,
font, stress and observability analysis only after evidence. No findings engine/DOM schema is
an M0–M3 blocker, and no AI reviewer is introduced. Findings identify possible presentation
problems; they do not certify accessibility or authenticate what a PR captured.

## 1. Rendered analysis, not source-code proof

Pixels answer what changed in submitted images. Rendered DOM/style/geometry can help identify
clipping, overflow, overlap or missing content, but availability depends on the capture adapter:
level 0 can have pixels only. Source lint flags risk factors, not actual clipping; rendered
heuristics also need exemptions and a truth-labeled corpus. “Deterministic” means repeatable
computation under specified inputs, not automatically accurate or trusted.

## 2. Research and what is actually transferable

| Work | Useful idea | Limit on this design's claim |
|---|---|---|
| ReDeCheck / responsive layout literature | Collision, protrusion, wrapping and width-dependent relationships | Background taxonomy; reproducing its detector/results is **verify**, not a shipped implementation |
| VISER (2019) | Issue-specific areas of concern and layered visual checks | The published method is more specific than hiding any implicated element; see §5.2 |
| ReFLAIR (FSE 2026) | Reflow may preserve content behind scroll/expansion; compare accessible functionality, not boxes only | The paper uses multimodal generative AI and dynamic analysis; a label-set heuristic is not a reproduction |
| Galen / Cornipickle | Explicit layout constraints can encode intent | Framework integration, current compatibility and comparative results remain **verify**; not an MVP dependency |
| WCAG understanding documents | Precise resize, reflow and spacing conditions | Heuristic browser probes alone do not prove conformance |

These are related work, not evidence that PixelWatch will achieve the papers' precision, recall,
speed or coverage. No model from ReFLAIR is brought into CI. The review inspected the primary
VISER method and ReFLAIR paper; other background research is not represented as reproduced.

## 3. Collector architecture, coordinates and trust

Capture optionally emits a bounded **minimal** probe record, not full page source by default.
Its collector runs alongside untrusted application code. Record collector/rule version,
provider/view/variant, browser version, capture geometry, completeness and unavailable features.
The trusted publisher validates/derives presentation from those records; it never reconnects
to a live PR page, executes a head script or treats the record as independently attested.

Chromium's experimental `DOMSnapshot.captureSnapshot` returns structured tables with shared
strings, node indices and layout/text-box data. It is not ready-made painted glyph polygons
and can include input/text values. Pin/test the actual browser/protocol
version, feature-detect and degrade to unavailable rather than fabricate fields. Non-Chromium
fallbacks are separate implementations, not assumed equivalent.

Do not confuse a snapshot table index, `DOM.BackendNodeId` and `DOM.NodeId`.
`CSS.getPlatformFontsForNode` takes a **DOM.NodeId** and reports fonts used by child text nodes
. Resolve backend nodes through the appropriate DOM commands for the pinned
protocol; never pass a table index directly. One sample per CSS font-family is insufficient
for different weight/style/unicode coverage; font fallback may be legitimate, not a defect.
Start with explicit expected-font assertions on a small configured element set, not a universal
fallback-error rule. Actual font evidence may be unavailable; expose that state.

Normalize all rectangles to a specified coordinate space. Capture metadata must include crop
origin, scroll offset, actual PNG dimensions and effective X/Y pixel scales. DOM CSS pixels,
viewport coordinates, device pixels and full-page/element screenshots differ. Transform into
PNG-space and clip only after validating finite coordinates/bounds. `Range.getClientRects` and
layout boxes approximate text layout, not exact glyph ink or every clip-path/transform. Complex
clipping/transforms may require “unsupported/unverified” instead of a confident clipping claim.

**Privacy:** full snapshots can expose input values, text, URLs and unrelated content. Allowlist
only necessary fields, strip values/secrets, bound selector/label text and total compressed plus
expanded bytes. Do not upload or publish raw `layout.json.gz`, HAR, trace or console/network
payloads by default, including on main. Optional diagnostic artifacts need an explicit retention
and disclosure policy; public Pages is not a safe diagnostic bucket. A publisher reanalysis of
stored minimal records is possible only if the required fields actually exist and are compatible.

## 4. Rule catalogue (future, advisory by default)

### 4.1 Text

Candidates: clipped text, intentional truncation, unusually small text, suspicious placeholder
text and configured expected-font mismatch. Geometry alone can confuse whitespace with ink or
intentional ellipsis with loss of required content. Begin at `info`; use explicit assertions and
verified observability for stronger severity. Never assume the first CSS family must render
every glyph, especially across scripts, emoji or missing font subsets.

### 4.2 Layout

Candidates: unexpected horizontal overflow, element protrusion/collision, wrapped groups and
control occlusion. Overlap of DOM rectangles is not automatically a bug; parent-child overlap,
transparent wrappers, positioned decorations and scroll areas are common. Keep candidate
geometry separate from verified visible failure and allow configured intent constraints.

### 4.3 Content/state (M4 candidates)

Broken images (`complete`/`naturalWidth` with loading state accounted for), configured error or
spinner markers, unexpected horizontal scroll and known fixture placeholder text are suitable
first probes. Console errors need bounded sanitized categories, not arbitrary public log dumps.
A blank-looking screenshot can be intentional. State probes require readiness/timeouts; they
must not hide capture setup failures behind “zero findings”. M4 selects only probes demonstrated
on maintained fixtures, not the whole catalogue.

### 4.4 Stress passes (M6)

Text spacing: test user-style conditions for line height 1.5× font size, paragraph spacing 2×,
letter spacing 0.12× and word spacing 0.16×, with applicability/exceptions understood. Text resize
checks up to 200% and reflow at 320 CSS pixels are different criteria.

`deviceScaleFactor:2` changes device pixel density, **not** text-only enlargement. CSS zoom is
not equivalent to browser zoom or text-only resizing. Implement a specifically documented test
method, record actual viewport/font metrics and validate it against explicit browser fixtures;
proxy passes are labeled exploratory, not WCAG passes. Reflow exemptions include content that
requires two-dimensional layout (for example maps/data tables), not an automatic exception for
all overflowing UI.

Pseudo-localization and style changes can trigger mutation observers, framework reconciliation,
font loading and asynchronous application behavior even when a clock is frozen. Use isolated
capture pages or well-defined restore/cleanup; do not claim these passes never run app code or
are pure layout transformations. Verify settled state and bound time/work. Captures remain
untrusted and opt-in; no real-user form values are mutated/published.

### 4.5 Responsive sweep (M6)

Sampling 320 through 1920 inclusive in steps of 16 gives **101 widths**. It cannot establish an
exact failing interval such as 768–812: 812 is not sampled. Report failing samples (e.g.
768/784/800), neighboring tested negatives (752/816) and the untested gaps. Narrow failures
between samples can be missed. Adaptive boundary refinement is a later optional technique,
not a guarantee that a finite sweep proves all widths.

A desktop control absent at mobile may be behind a menu or horizontal/vertical scrolling.
Matching label sets does not establish reachable equivalent functionality. Detect known
explicit patterns conservatively, otherwise report unknown and request human interaction review;
do not claim ReFLAIR-level detection from a non-interactive heuristic.

### 4.6 Explicit assertions

A small declarative vocabulary can capture intent: element inside container, minimum gap,
expected visibility and expected font for a named element. Its schema, selector limits, failure
semantics and maintenance burden need a separate M6 decision. It must execute only in capture,
not become a publisher DSL with arbitrary JS/CSS/URLs. Assertions identify expectation failures,
not a broader security/semantic correctness guarantee.

### 4.7 Accessibility

Axe-core may add a curated set of automated checks after version-specific testing. **verify**
current rule IDs/default inclusions and performance; don't equate a historical tap-target audit
with all current WCAG target-size requirements. Automated scans cover a subset of accessibility
requirements and cannot replace a human audit. Pin/update the dependency and retain rule version.

## 5. False positives and regression semantics

### 5.1 Comparable baseline first

Finding identity includes rule version, provider/view/variant, pass and stable element identity.
Prefer test IDs, then unique IDs, then carefully matched role/name; CSS paths/text hashes are
fallible fallbacks, not stable identity guarantees. Collisions and uncertain matches remain unknown.

Classify findings as `new`, `existing`, `resolved` or `unknown` only when both analyses have
compatible rule/collector versions, required probes and a comparable captured state. First
adoption/no baseline is **unknown**, not “0 new findings” presented as a clean result. Different
rule versions can be reanalyzed only from sufficient stored compatible minimal data; otherwise
skip comparison with a note. Reanalysis creates a versioned result and preserves originals.
Raw layout is never made mandatory merely to make future reanalysis convenient.

### 5.2 Observability verification (VISER-inspired, not a shortcut)

Hiding a visible element and seeing pixels change proves that the element contributes pixels,
not that its overflow/collision is visible. The proposed original “hide element; any changed
pixel confirms issue” test would confirm many false positives.

VISER uses issue-specific **areas of concern** (such as the protruding/intersecting region) and
separate visual states for relevant elements/background/layers. A future
implementation must define control captures per rule, isolate that issue region, account for
clipping/paint order and require the expected visible relationship—not any pixel difference in
an element's whole bounding box. Apply/restore styles with `try/finally`, avoid layout reflow
as a confounder, disable relevant transitions and ensure comparable settled captures. Unsupported
cases stay `unverified`/info. The method needs positive and intentional-lookalike fixtures before
higher severity; “typically 0–5 candidates, ~50 ms each” remains **verify**.

### 5.3 Exemptions require actual visual evidence

`aria-hidden=true` affects accessibility exposure, not necessarily visual rendering. It is not
a blanket visual exemption. `display:contents` removes a wrapper box, not its visible children.
A class named `sr-only` does not prove the applied CSS actually hides it. Recognize tested
visual patterns, not names alone. Off-screen skip links can become visible on focus.

Scroll containers and carousels may intentionally clip, but content still needs a usable way to
reach it; don't exempt every `overflow:auto` element automatically. Intentional ellipsis can be
info with an explicit reason. Ignore rules require bounded selectors and reasons, are visible
in reports, and remain capture claims when supplied by a PR. They cannot silently change trusted
required coverage or suppress publisher warnings.

### 5.4 Calibration

Use a labeled corpus containing true failures and intentional lookalikes, across multiple apps,
widths/fonts/scripts. Separate fixed/training fixtures from held-out validation. User dismissals
or fixes alone are biased and not a precision estimate. A proposed >90% precision promotion
threshold must state sample size, rule, labeling method and uncertainty; a few successes do not
justify it. Until calibrated, keep heuristics advisory/info. Explicit user assertions may have
stronger severity but still do not attest the PR capture was honest.

## 6. Presentation

Viewer overlays and agent fields carry rule/collector version, severity, comparison state,
pass, coordinate space, evidence/unsupported reason and provenance. Crop images are derived
from validated pixels, not remote supplied URLs. Comments never sacrifice missing/failed
coverage warnings for finding counts. The future `lint` command launches the app and executes
capture/probes; it is not a read-only metadata query, and screenshot-free mode cannot perform
pixel observability verification. A `new-error` gate requires comparable baseline evidence and
an explicit later design; it is not an MVP default.

## 7. Configuration split

Collection rules/selectors/stress options live on the capture/head side and remain untrusted.
Trusted default-branch policy bounds work, publication, severity presentation and any future
approval behavior. Do not allow a head-provided `off`, ignore selector or forged `observable:true`
to claim independent assurance. Start with a small closed schema when M4 begins; no speculative
all-rules schema in M0. Raw CSS/JS and arbitrary URLs are not presentation configuration.

## 8. Cost: hypotheses, not measurements

All earlier per-capture timing/storage estimates remain **verify** until S10/S12. Arithmetic
alone does not justify the narrow aggregate forecast: DOM 50–300 ms ×42 = **2.1–12.6 s**; axe 100–2000 ms ×42
= **4.2–84 s**. Together that is **6.3–96.6 s per revision**, before verification/stress/sweeps,
not a justified 10–30 s forecast. Real parallelism/startup/DOM size can change totals further.

Measure p50/p95/timeouts, bytes before/after compression and peak memory on small/large pages.
Multiply base and head and variant counts explicitly. A 101-width sweep is not “~10 s/view”
without measurements. Main-only diagnostic retention still consumes storage/privacy budget;
50–300 KB per layout snapshot is an unverified planning range, not a retention bound. Keep
axe/full DOM/stress off by default until cost and value are established.

## 9. Prototype examples

Miswrapped header pills, persistent spinners and loading-state captures are promising fixtures,
not proven detections by this unimplemented engine. The source screenshots needed to test those
claims were not supplied. Preserve them as labeled examples when provided.

The reported Feature 3 `100vh`/full-page screenshot issue is a **specific observed capture
artifact**, not a general claim that full-page captures always stretch viewport units. Reproduce
with the actual browser/capture settings before writing a detection rule; an element-capture
workaround can itself change geometry and must record its origin/scale.

## 10. Roadmap and evidence

M4: a few minimal privacy-reviewed advisory probes with fixture tests. M5: projections/identity
extensions only for shipped variants/flows. M6: calibrated layout rules, coordinate/font
collector, observability, stress/sweeps, optional axe and compatible reanalysis. No M0–M3 overlay
hook or raw-DOM persistence requirement. Add the collector/rule schema only when its data is
actually known. The live timing/calibration work is S10/S12 in `../08-implementation-plan.md` §7.

## Sources and verification boundaries

Primary sources are listed in [../reference/platform-facts.md](../reference/platform-facts.md) (DOMSnapshot, CSS fonts, WCAG, VISER, ReFLAIR).

The primary papers support the described methods, not a promise
that PixelWatch reproduces their outcomes. Additional original background references below are
retained as leads; details/compatibility and any uninspected paper's findings are **verify**:

- ReDeCheck: https://github.com/redecheck/redecheck ; ISSTA 2017 DOI https://doi.org/10.1145/3092703.3092712
- STVR visual classification: https://doi.org/10.1002/stvr.1756
- STVR responsive regression: https://doi.org/10.1002/stvr.1748
- Galen: https://galenframework.com/
- Cornipickle: https://www.sciencedirect.com/science/article/pii/S2352220816300293
- WCAG F104 technique: https://www.w3.org/WAI/WCAG21/Techniques/failures/F104
- Current axe rule descriptions: https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md
