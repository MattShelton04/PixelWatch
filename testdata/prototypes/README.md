# Prototype capture output (realistic converter input)

These are verbatim capture manifests from the two prototypes, plus one real screenshot from
each. They're **example input** for the `bundle@1` converter tests. They're not a correctness
standard: tests check properties (the output converts, is schema-valid, counts add up and IDs are
right), never byte-exact converted output.

| Folder | Source | Revisions |
|---|---|---|
| `propertyscope-36405830015/` | PropertyScope Visual Capture run 36405830015, attempt 1 (PR #123) | base `a2c66ec…`, head `8fc85c2…` |
| `tracepilot-36314265418/` | TracePilot Desktop Visual Capture run 36314265418, attempt 1 (push to `main`) | base `77616ca…`, head `067cfcd…` |

Each subfolder is named after the uploaded artifact. The other screenshots aren't committed;
the tests substitute a tiny valid PNG for them. Run `node tools/check-reference-conversion.ts`
to convert the full local copies in `.reference/` (ADR 0001) with every real screenshot.
