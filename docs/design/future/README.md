# Future designs (M4+): not MVP

Nothing in this folder is to be implemented during M0–M3. The files record researched ideas so
they aren't lost. When M3 exits, plan M4 from real adopter evidence, then promote the relevant
parts into the main design with proper tasks. The main design files override anything here.

| File | Milestone | Summary |
|---|---|---|
| [capture-and-sharding.md](capture-and-sharding.md) | M4–M5 | `views.yml` recipe runner, hooks, `snap` SDK, public CLI, `init`, dynamic shard planner |
| [review-features.md](review-features.md) | M3 background, M5–M6 | Variants and matrix viewer, flake detection, change attribution, local parity, baseline reuse |
| [motion-and-flows.md](motion-and-flows.md) | M5–M6 | Flow filmstrips, sampled animations, animated previews |
| [comments-studio-and-skills.md](comments-studio-and-skills.md) | M4–M6 | Comment blocks, Studio, agent setup/review skills, MCP |
| [layout-findings.md](layout-findings.md) | M4 cheap probes, M6 advanced | Clipped text, overflow, collisions, fonts, stress passes |

Standing rules for all of it:

- Capture-side features run untrusted.
- Anything the capture side produces stays a claim.
- Every new codec, parser, DSL or credential is a maintenance and security cost that needs
  measured evidence of need first.
- No AI reviewer in CI.
