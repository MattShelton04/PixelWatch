# ADR 0010: Simplification pass before M1.5

- Status: proposed
- Date: 2026-10-02
- Task / spike: between M1.4 and M1.5

## Context

M0–M1.4 delivered working, tested code. A review before M1.5 found machinery that costs code,
CPU or contract surface without protecting anything the security model (01 §4) asks for. Each
item below says what it was, why it doesn't earn its keep, and what replaces it. None of them
weakens a 01 §4 rule. Where a threat-model row pointed at removed code, the row now points at the
check that still enforces the rule.

## Decision

### 1. Config is JSON (supersedes ADR 0009)

The adopter config is `.pixelwatch/config.json`, read through the same strict JSON parser and
schema validation as every other document (`parseDocument("config", bytes)`).

- ADR 0009 wrote a 380-line YAML subset parser, plus differential tests against the `yaml`
  package, to make sure a document means the same under YAML 1.1 and 1.2. JSON has no such
  ambiguity, and we already have a hardened parser for it. The config is about ten lines.
- The `theme` fallback is gone. An invalid setting fails like any other (02 §10 only said it
  *may* fall back).
- Removed: `packages/core/src/config/`, its tests, and the `yaml` devDependency.
