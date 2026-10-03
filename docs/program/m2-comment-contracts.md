# M2.3 comment renderer contracts

Root owns types/exports/ADRs and the pure renderer slice. Implementation follows ADR0026;
no producer/action/workflow uses the renderer until independent review and integration.

`renderComment({context,run,generation}): RenderedComment` captures/validates all input
before rendering. Unknown versions refuse even when comments are disabled. Output is either
disabled or rendered with body, fallbackBody, bytes, degradation full/shortened/summary and
stamp. A stamp has runKey, optional headSha and generation. readCommentStamp(body,repositoryId)
returns a checked stamp or undefined; it authenticates no author and selects no write target.

Required: fixed title and exact numeric ownership marker; source identity/status, warning
categories/counts/incomplete and unknown missing work, advisory capture trust warning, actual
counts, generated full-report link. Optional rows40×256 then10×64 thennone. Final body≤60000
UTF-8 bytes, plain fallback≤8192. No image until genuine publisher generation/probe integration.
No visual changes only with nonempty complete-declared comparable unchanged results and a
corroborated baseline/head. Missing/failed/incomparable/added/removed/subtle/changed never
masquerade as unchanged. No capture claims/error text/templates/URL destination are rendered.

Tests first: all eight statuses, initial baseline absent, missing catalogs with unknown counts,
complete unchanged truthful verdict, injection context/bidi/mentions, natural maximum escaped
multibyte body degradation/warning retention, unknown config/run versions, foreign repository,
hostile getters/caller methods, marker/stamp spoof/duplicate/unknown shape. Tests read committed
fixtures only; full raw output/error scans use fake tokens/signed URLs. Independent security and
correctness reviewer must inspect/attack outputs and verify named reached cases. Root runs
final check/fullcoverage/browser; real sticky API/readiness/fallback/live remain later gates.
