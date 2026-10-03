# ADR 0026: Fixed MVP comment renderer

- Status: accepted (owner approved fixed title/limits; concrete renderer details inferred under ADR 0014)
- Date: 2026-10-03
- Task: M2.3

## Context

05 §1 says trusted config controls title and display limits, but frozen config@1 exposes only
comment.enabled and theme.preset. Adding configuration fields would unnecessarily change the
canonical contract. The owner approved the fixed MVP PixelWatch title and bounded limits.
PropertyScope scripts/visual/comment.py at the ADR0001 commit uses identity, verdict/counts,
bounded lists, optional detail and report/history links. Its bot-login ownership and generic
HTML templates cannot replace PixelWatch's numeric-author/marker trust boundary.

## Decision

Preserve config@1 and correct 05. Use fixed title PixelWatch, at most40 optional rows with
256-code-point labels, then10 rows with64-code-point labels, then required summary only.
Measure after canonical safe text/context escaping and generated URL expansion, with the
existing60000-byte cap. Reserve identity/status/warnings/report link before optional detail.
Always provide a deterministic plain text fallback at most8192UTF-8 bytes for the caller's
single API-rejection fallback attempt. No raw capture diagnostic appears in Markdown.

The renderer is pure and takes the validated run, trusted publisher context and generation;
all links derive from that context and validated IDs. It makes no readiness or mutation claim.
The initial slice emits text links only; optional PNG preview requires a later actual bounded
publisher-generated/probed image before inclusion. This is the supported S1 fallback.
Use one exact numeric repository ownership marker and a bounded v1 report stamp containing
run key, head (or none) and generation. Unknown/duplicate/malformed stamps are unavailable
to the reconciler, never proof of ownership or permission to overwrite a newer report.

These concrete limits/stamp details are implementation inferences, not owner-approved new
policy or a schema version change. Independent review and integrated use remain gates.

## Consequences

No external runtime/dev dependency, schema, changes@1 byte or recorded golden changes.
Capture Markdown, HTML, bidi/control text and mentions cannot become templates or destinations.
The renderer alone does not prove comment safety/order, live rendering or M2 exit; the serialized
caller must establish current-head/latest-pointer/readiness and use the forge mutation guard.
