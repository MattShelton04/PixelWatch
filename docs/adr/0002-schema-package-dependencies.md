# ADR 0002: Schema package dependencies and strict JSON parsing

- Status: accepted
- Date: 2026-09-30
- Task / spike: M0.3

## Context

`packages/schemas` validates every document PixelWatch reads (02 §1). The publisher validates
untrusted `bundle@1` input with it, so it's in the trusted path. 08 §3 requires an ADR for any
new runtime dependency there.

Two requirements can't be met with the platform alone:

- **JSON Schema 2020-12 validation.** This needs discriminated unions, code-point `maxLength`,
  `additionalProperties: false` everywhere, and a strict mode that rejects schema typos.
- **Duplicate-key rejection** (02 §5, 07 §3). `JSON.parse` silently keeps the last duplicate, so
  it can't be used for untrusted input.

## Decision

| Package | Version | Scope | Why |
|---|---|---|---|
| `ajv` | 8.20.0, exact | runtime | Mature 2020-12 validator with a strict mode and discriminator support. Adds 4 small transitive deps (`fast-deep-equal`, `fast-uri`, `json-schema-traverse`, `require-from-string`). |
| `json-schema-to-typescript` | 16.0.0 | dev only | Generates `src/generated/types.ts` from the schemas (`pnpm schemas:types`). Never runs in the product. |

Ajv settings:

- `Ajv2020` with `strict: true`, `discriminator: true`, `allErrors: false`,
  `validateFormats: false` (no `format` keywords are used; patterns do the work) and
  `unicodeRegExp: true`.
- `common.json` `$defs` are inlined into each schema at load time. No `$ref` is ever resolved
  over the network.

**Own strict JSON parser** (`src/json.ts`, no dependency):

- Size ≤ 1 MiB and nesting depth ≤ 32 by default.
- Rejects a BOM, invalid UTF-8 (fatal decoder), and lone surrogates in strings.
- Rejects duplicate keys at any depth, and the keys `__proto__`, `constructor` and `prototype`.
- Accepts **safe integers only**, and rejects `-0`. No fractions or exponents appear in any
  PixelWatch document, and canonical JSON (02 §3) can't represent them anyway.

A generated-types test fails if `src/generated/types.ts` is stale.

## Consequences

- The trusted path grows by ajv and its 4 deps, pinned by the lockfile and watched by Dependabot
  and dependency review.
- Ajv compiles validators with `new Function`. That's fine in Node. The viewer's CSP has no
  `unsafe-eval` (04 §4), so M2.7 must use **Ajv standalone precompiled validators** (or not
  validate in the browser). Noted here so M2.7 doesn't discover it late.
- Any future document parser in PixelWatch goes through `parseDocument`, never `JSON.parse`.
- No change to `docs/design/`.
