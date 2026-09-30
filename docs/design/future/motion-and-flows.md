# Future · Motion, flows and video evidence

**Future design:** flow filmstrips M5; sampled animation M6; animated previews only after live
format/cost tests. **None is an M0–M3 gate.** MVP uses still PNG images and a text-link fallback.
No new video/animation codec is added to the trusted publisher merely because it can be bundled.

## 1. Four kinds of moving evidence

| Kind | What can be compared | Qualification |
|---|---|---|
| Flow filmstrip | Explicit stable-ID still frames after scripted steps | Reproducible only to the extent app/data/environment and timing are controlled |
| Sampled animation | Stills at explicitly defined finite times | Clock control does not cover every rendering/animation source |
| Animated preview | Derived view of already validated frames | Visual aid; format acceptance/size/playback through Camo is **verify** |
| Screen recording | Human-readable failure sequence | Do not pixel-diff compressed video; timing and encoding vary |

## 2. Flow filmstrips (M5)

### 2.1 Authoring

A future recipe/SDK emits named `snap` steps: `empty`, `dialog`, `filled`, `created` after the
corresponding interaction/wait. Frames have stable IDs, not ordinal-only identity. On failure,
record the failed step and later frames as unexecuted/failed coverage, not absent/removed.
Capture continues to run untrusted; captions/step labels are untrusted data.

### 2.2 Storage and identity

Extend the provider/view/variant tuple with an explicit versioned frame identity and ordered
flow manifest; do not concatenate slashes into the MVP flat-ID format. Frames use canonical
still PNG blobs and ordinary retention references. Derived previews have separate byte-hashed
identities and limits. Step insertion does not relabel every subsequent frame.

### 2.3 Comparing flows

Record frame results plus a flow outcome. Identical earlier frames do not make a flow successful
when a later click or wait failed. A reordered catalog is separate from pixels changing.
Apply the same missing/failed/absence distinctions as `../02-contracts.md` §4 and do not fabricate removed
frames from an incomplete head run.

### 2.4 Viewer

Filmstrip, keyboard stepper and optional lockstep playback reuse current comparison modes.
Playback selects still frames, not a new video file; extra decoded frames nevertheless cost
memory/network even if no extra encoded blobs are stored. Bound preloading, honor reduced
motion, allow pause and preserve accessible captions. Do not autoplay large previews by default.

## 3. Sampled animations (M6)

The earlier `p * effect.getComputedTiming().endTime` sketch is not a general implementation:
`endTime` can be infinite, and delay/repeat/direction/fill/timeline semantics matter. Define
samples as finite milliseconds within an explicit bounded interval; reject unsupported or
unbounded timelines, or require a per-animation sampling policy. Handle finished, pending,
zero-duration and detached effects. Test negative delays, infinite iterations, alternate
animation direction, transitions and newly created animations.

Pause relevant Web Animations, set finite current times and perform a bounded render flush.
If Playwright's fake clock has paused `requestAnimationFrame`, awaiting two RAFs without
advancing that clock can hang. Coordinate the flush with explicit bounded clock advancement and
an external timeout. `page.clock.install()` must precede app clock usage; `runFor` and
`fastForward` have different scheduling behavior.

This controls selected timers/animation APIs, not all network completion, observers, media,
WebGL/game clocks or asynchronous application behavior. State settling and masked unsupported
regions remain necessary. **verify** reproducibility on explicit animation fixtures before
labeling samples deterministic. Do not freeze a clock and claim no application code can react.

## 4. Animated previews for comments (M5–M6)

MVP accepts only static PNG output. A later experiment may generate GIF/APNG/animated WebP from
validated frames. GIF palette limitations and animation-specific codecs make comparative size
content-dependent; don't claim one format is always smallest. Lossless WebP requires an explicit
encoder mode; “lossless or near” is not one fidelity contract.

Camo's current hosted MIME whitelist, size ceiling and animation handling are **verify — S1**.
The upstream archived Camo defaults are not hosted GitHub promises.
Use a real PR, correct Content-Type, bounded GET and browser observation of multiple frames;
a HEAD request or accepted MIME type alone does not establish animation playback. Test failure
fallback rather than assume APNG works whenever PNG works.

A proposed 2 MiB preview budget is a product policy, not a known Camo maximum. Start with one
small side-by-side preview and a static PNG fallback; preserve full-resolution frame links.
Every codec adds dependency review, fuzzing, memory limits, releases and browser/Camo tests.
Keep it deferred unless static filmstrips prove insufficient. OG images stay static PNG.

## 5. Recordings and traces (optional, separately scoped)

Recordings can help humans diagnose failed flows but are not part of the canonical image store
in MVP. Their size depends on duration/resolution/content; “1–10 MB each” is an unverified
planning example, not a bound. A future implementation needs encoded-byte/duration limits,
separate retention and a safe viewer/link fallback. **verify** then-current GitHub attachment/API
support instead of assuming an undocumented video-upload route or blanket impossibility.

HARs/traces/DOM snapshots/videos may contain user data, passwords, session cookies, response
bodies, URLs and unreleased content. Do not automatically publish them to public Pages or the
agent API, even on failure or on main. Opt-in diagnostics need synthetic fixtures, redaction,
restricted artifact handling and documented retention. Public fixtures can still accidentally
contain secrets. Linking a trace viewer to a public trace exposes the trace URL and may require
CORS; **verify** before offering remote viewing, with a local download/view option as fallback.

## 6. Feasibility and maintenance

| Item | Earliest milestone | Continuing cost / condition |
|---|---|---|
| Flow stills and viewer stepper | M5 | Schema/frame identity, incomplete-step tests, retention and accessibility |
| Sampled animation | M6 | Timing/engine fixtures and unsupported-animation behavior |
| Animated comment preview | M5–M6 | Codec security, bounded encoding, hosted Camo smoke tests; optional |
| Failure recording/trace links | After an explicit privacy decision | Redaction, bytes/retention, playback/CORS and support docs |
| Nightly demo reel | Unscheduled | Storage/CI cost without improving MVP correctness; cut until requested |

These are potential extensions, not claims that the current product implements them.
