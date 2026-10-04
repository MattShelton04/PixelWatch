# ADR 0031: Genuine comment operation completion

- Status: owner decisions recorded; component implementation independently reviewed
- Date: 2026-10-04
- Scope: M2 projection completion and existing GitHub adapter lifecycle

An actual HTTP201 can arrive before the request deadline disposer aborts the outer publisher
signal. Discarding that already accepted result reports a failed comment despite a real write.
Conversely, waiting for an arbitrary injected operation after cancellation can defeat the work
bound. A public ForgeError category or a method name cannot prove a real HTTP422 or acceptance.

The adapter returns the exact privately recorded native operation promise. The additional
isOwnedCommentOperation predicate binds that promise to the repository and the same freshly
frozen invocation with plain captured fields and a genuine caller AbortSignal. It reads no
foreign promise properties. Mutable inputs, accessor inputs, missing caller signals, aliases,
fabricated promises and another invocation receive no completion authority. Legacy calls still
execute normally; the predicate is a narrower publisher completion protocol.

The genuine implementation uses private comment discovery, observes ordinary native injected
promises through the captured intrinsic then, bounds guards and retry delays by the existing
caller signal, and arms request cancellation before scheduling transport. The scheduled
reaction checks cancellation again. Request, retry, comment and ten-minute publisher bounds
remain unchanged; there is no extra grace period or permitted mutation after cancellation.
Signals are composed with captured native getters and listener operations rather than
AbortSignal.any, which can read an overridden aborted getter. Public catch decisions also use
native state and never echo the caller's reason or a shadow getter exception.

Manual native listener removal allows the abort callback to settle before a throwing native
unlink hook. Every acquired request deadline is disposed even if listener cleanup fails.
A validated real comment acceptance survives cleanup failures with at most the two fixed
warnings listener-cleanup-failed and timing-disposal-failed. Projection must validate and retain
these warnings in its accepted result. Cleanup before acceptance still fails safely and keeps
existing fixed diagnostic and retry behavior. Only a genuine current operation's actual
HTTP422 can authorize one newly guarded fallback; a public error constructor cannot.

The exact operation promise alone does not authenticate a mutable public result. Independent
review reproduced an earlier reaction changing a real deferred reply into created, and changing
a validated HTTP201 reply into deferred before projection captured it. The adapter freezes each
privately constructed comment result and a copied finite warning array before its promise
fulfills. This preserves actual unchanged, deferred, created, updated and recovered outcomes
without adding a reaction, request, retry or deadline. Original consumer reproducers and complete
integrated review remain required after the producer correction.

Mutation authorization is monotonic within each genuine invocation. A later retry guard cannot
erase the fact that an earlier POST or PATCH was sent. When cancellation rejects that operation
without a validated reply after authorization, projection reports comment-operation-failed;
it cannot manufacture a readiness deferral for an unknown sent write. An actual returned
validated deferred result retains its existing meaning, including a changed head after a 503.
A fresh invocation that has never authorized a mutation can defer after readiness cancellation,
and an already validated acceptance retains its created, updated or recovered result. The
independent reviewer agrees with this distinction. The precise new retry-cancellation
expectation change received direct owner approval on 2026-10-04 after automatic approval review
rejected it twice. Only the retry subcase changes to failed/comment-operation-failed;
first-write, fallback and coalesced cases retain deferred/readiness-pending. Original
accepted-result, head-change, no-write readiness, write-count and work-bound assertions remain
intact. The original failed run is retained; approval alone is no passing execution claim.

The owner approved the trusted adapter Promise boundary on 2026-10-04: transport, timing and
mutation-guard implementation ports must return ordinary native Promises with unmodified
native constructor/species. These are trusted in-process implementations, never capture or API
data. Existing own-then defenses, bounded work, fixed diagnostics and secret scans remain.
ECMAScript intrinsic then performs SpeciesConstructor before attaching handlers; the existing
remedy does not solve a hostile nonconfigurable Promise.constructor. Its original reproducer
remains retained failing, out-of-contract evidence, not a closed adversarial test. This explicit
boundary decision resolves that release blocker without global suppression or V8 internals;
independent review of the implementation within the approved boundary remains required.

Tests must preserve the original queued-dispatch, diagnostic, retry, guard and response-getter
assertions. Tests-first native unlink/acquisition, rejected own-then canary, exact invocation
provenance and accepted-cleanup cases plus unchanged independent reproducers remain required.
Actual complete integration, simulations, three-engine browsers and hosted evidence are
separate gates after the final source is integrated.
