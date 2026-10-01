# ADR 0009: Trusted config is a restricted YAML subset

- Status: accepted
- Date: 2026-10-01
- Task / spike: M1.4

## Context

02 §10 says to parse the default-branch YAML "as a restricted JSON-compatible mapping, then
validate the exact schema". 02 §5 refuses YAML aliases, custom tags, duplicate keys,
non-finite numbers and anything over 1 MiB. Full YAML parsers have two problems here:

- They resolve plain scalars differently by version. Under YAML 1.1, `on`, `yes` and `y` are
  booleans, `012` is octal, `1_000` and `1:30` are integers, `2001-12-14` is a timestamp and `<<`
  merges. YAML 1.2 reads all of these as strings or decimals.
- They bring anchors, tags and multi-document streams, which config never needs.

Adopters will write the file with whatever tooling and habits they have. So a config must mean
the same whichever YAML version a person or tool assumes. Owner decision (2026-10-01): write our
own subset parser. The `yaml` package is a dev-only dependency, used for differential tests.

## Decision

`parseYamlSubset` (`packages/core/src/config/yaml.ts`) accepts only:

- **Input:**
  - UTF-8 without a BOM, at most 1 MiB, nesting at most 32;
  - LF or CRLF line ends, with no lone CR;
  - no tabs, C0/C1 controls, NEL, LS, PS or BOM characters anywhere;
  - `#` comments, and one optional leading `---`.
- **Structure:**
  - block mappings whose keys are identifiers (`[A-Za-z_][A-Za-z0-9_-]*`, not
    `__proto__`/`constructor`/`prototype`), with no duplicates;
  - block sequences, including compact ones under a key and `- key: value` items;
  - one-line flow sequences of scalars.
- **Scalars:**
  - double-quoted, with JSON escapes except `\/` (YAML 1.1 lacks it), and no surrogate escapes;
  - single-quoted;
  - plain `true`, `false`, `null`, decimal safe integers without leading zeros, signs or `-0`;
  - plain strings starting with a letter, `_` or `/`, using letters, digits, space and `_./()+-`.

Everything else is refused with its own code:

| Codes | Refused |
|---|---|
| `yaml-anchor`, `yaml-alias`, `yaml-tag`, `yaml-merge-key`, `yaml-complex-key` | anchors, aliases, tags, merge keys, complex keys |
| `yaml-block-scalar`, `yaml-flow-mapping` | block scalars, flow mappings |
| `yaml-directive`, `yaml-multi-document` | directives, multiple documents |
| `yaml-duplicate-key`, `yaml-unsafe-key` | duplicate and unsafe keys |
| `yaml-ambiguous-scalar` | any case of y/n/yes/no/on/off/true/false/null and `~`, other than lowercase `true`, `false`, `null` |
| `yaml-number` | non-integers, unsafe integers, leading zeros, signs, `0x`/`0o`/`0b`, `_`, sexagesimal, timestamps, `.inf`/`.nan`, and bare exponents such as `e5`, which the `yaml` package's 1.1 schema reads as a float (found by the differential test) |
| `yaml-escape` | escapes outside the allowed set |
| `yaml-empty-value` | empty values (write `null`) |
| `yaml-indent` | inconsistent indentation or multi-line scalars |
| `yaml-tab`, `yaml-encoding`, `yaml-too-large`, `yaml-too-deep`, `yaml-syntax` | tabs, bad encoding, size, depth, other syntax |

Messages carry line numbers and fixed text, never input.

`parseConfig` (`packages/core/src/config/parse.ts`) runs the subset first, because a version
can't be read from a document that doesn't parse. Then `validateDocument("config")` runs, which
reports an unknown `schemaVersion` before any schema or semantic problem. The only fallback is a
malformed `theme`: it is dropped with a `theme-fallback` warning, and the default preset applies
(02 §10, "optional presentation setting"). Policy never falls back.

## Consequences

- An adopter must quote values that are ambiguous between YAML versions, for example
  `workflowIds: ["123456"]` (a plain `123456` is an integer and fails the schema). Errors name
  the line and the rule.
- `packages/core/test/config-parse.test.ts` holds the differential test. Every generated
  document the subset accepts must equal the `yaml` package's result under both 1.1 and 1.2.
  A second, unstructured fuzz run covers YAML punctuation. A divergence fails `pnpm check`.
- `yaml` is a root devDependency only. The runtime TCB gains no dependency.
- 02 §10 points here.
