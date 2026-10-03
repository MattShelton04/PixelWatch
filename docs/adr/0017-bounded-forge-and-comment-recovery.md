# ADR 0017: Bounded forge I/O and guarded comment recovery

- Status: accepted (inferred implementation details under the authorized MVP program)
- Date: 2026-10-03
- Task: M2.1a; source authentication remains a separate M2.1b slice

## Context

01 §4.3 requires authenticated, bounded artifact downloads with manual redirects, permanent
cross-origin auth stripping and no secret diagnostics. 05 §2 and R4.6-09 require a fresh head
and comment check before every mutation. Independent review reproduced two unsafe internal
retry sequences: a PR head changed during backoff before a second POST, and a newer owned
comment appeared during backoff before a second PATCH.

## Decision

These are implementation decisions, not additional owner approval or a changed trust model.

- GitHubClient has a fixed api.github.com origin and trusted owner/repo/numeric repository ID.
  Strict bounded JSON and safe numeric REST IDs are required. Pagination constructs repository
  routes itself rather than following Link destinations; duplicate IDs and count drift refuse.
- The HTTP transport streams bounded bytes with redirect: manual. Limits are 1 MiB JSON,
  1,024 listed artifacts/comments, 128 MiB per artifact, 256 MiB per selected attempt,
  60 s requests, three request attempts/redirects, and at most 60 s numeric retry delay.
  Selected descriptors must be original immutable objects listed by this client for one source run.
  Copy the caller's selection before asynchronous work; no later additions bypass that check.
- Cross-origin redirects permanently drop Authorization, including a redirect back to the API.
  Expired/gone/retry-exhausted downloads return bounded missing categories. Malformed responses,
  unsafe locations and bounds violations refuse. Public errors never retain response bodies,
  raw URLs, transport exceptions or causes. Timing is injected for deterministic tests.
- Sticky comments require the exact repository marker and numeric bot author. Multiple matching
  comments refuse. A missing, malformed or throwing mutation guard refuses safely.
  The mandatory beforeMutation(existing): Promise<boolean> runs immediately before every
  POST/PATCH. Publisher checks current PR head, pointer/readiness and order there;
  false returns deferred without mutation. An unchanged body performs no write.
  Copy trusted mutation targets/body/guard at entry and give the guard a separate immutable
  comment snapshot. A callback cannot redirect the private validated comment ID.
- After an unknown/retriable write, backoff precedes fresh discovery. Rediscovery proves either
  the intended write happened, or unchanged ownership/content or absence before another
  guarded write. Changed/disappeared/ambiguous targets refuse. No blind mutation retry.
- Pages preflight reads settings only and validates Actions source, HTTPS host and exact project
  or custom-domain path. Publisher ownership/pre-existing-site refusal remains M2.3.

## Consequences

The root owns manifest/lockfile. The package uses only the existing schemas workspace dependency;
no new trusted runtime or development dependency. The corrected infrastructure has 28 passing tests;
source-authentication tests belong to the separate slice.
Independent review verified both harmful interleavings and scanned raw product errors using
fake canaries before harness redaction. Source envelope, publisher lock/readiness/comment
ordering and live fork acceptance remain open. This callback does not make separate GitHub
reads/writes atomic; publisher still holds the site lock and rechecks before each write (05 §2).
