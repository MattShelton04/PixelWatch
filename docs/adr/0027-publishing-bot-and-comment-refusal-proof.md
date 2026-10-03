# ADR 0027: Fixed publishing bot lookup and definitive comment refusal

- Status: inferred implementation decision under ADR 0014; independent review pending
- Date: 2026-10-03
- Task: M2.3/M2.5 adapter prerequisites

## Context

05 §2 requires the publishing bot's numeric author ID. The capture actor, artifact claims
and bot-looking logins cannot supply it. The workflow uses its own `github.token`, but the
existing adapter requires callers to supply a bot ID. A public account lookup cannot identify
the author of arbitrary PAT/App credentials. The renderer supplies a bounded plain fallback;
the existing adapter conflates HTTP422 validation rejection and authorization refusal.

Official [user lookup](https://docs.github.com/en/rest/users/users#get-a-user) and
[comment creation](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)
documentation were checked on2026-10-03. The fixed public
[GitHub Actions bot record](https://api.github.com/users/github-actions%5Bbot%5D) returns
numeric ID41898282 and typeBot. HTTP422 denotes validation failure or spam refusal; it does
not prove that a particular Markdown construct was rejected.

## Decision

Add `getPublishingBot()` which requests only the fixed GitHub.com Actions bot endpoint,
requires the exact account login/type and a safe numeric ID, and uses the existing bounded
read/retry/deadline policy. Its result authenticates server account metadata, not arbitrary
credentials. Production publishing accepts only the workflow's own `github.token`; existing
comment discovery and mutation-response checks still require that numeric author ID.

Expose a fresh private-provenance `comment-body-rejected` diagnostic only for a definitive
HTTP422 mutation response. The category means the submitted comment was refused; it makes no
claim about the response's prose. Keep authorization, network and uncertain outcomes distinct.
The later reconciler may make one freshly guarded renderer-fallback attempt on that proof;
this adapter change itself never retries with alternate content. Unknown outcomes retain
existing rediscovery/recovery rules. No raw response body, token, URL or error cause escapes.

## Consequences

No new dependency, permission, schema, golden or destination override is introduced. Identity
lookup is fixed adapter code; capture cannot choose an endpoint or bot. Token-author mismatch
remains a refusal rather than evidence of ownership. Complete fake-API acceptance and an
independent adversarial review precede integration; actual workflow/live use remains a gate.
