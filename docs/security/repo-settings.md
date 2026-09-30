# Repository settings checklist (M0.2)

GitHub settings for `MattShelton04/PixelWatch` that the code can't set or enforce by itself.

On 2026-09-30, at the owner's request, the agent applied every row below through the REST API
(`gh api`) and read each one back. Rows 11 and 12 were already correct and were left unchanged.
The owner still confirms them by hand and records the date at the bottom.

| # | Setting | Required value | Applied and read back (2026-09-30) |
|---|---|---|---|
| 1 | Visibility | Public (design scope is public GitHub.com repos, 01 §5) | public |
| 2 | Ruleset "Protect main" (default branch) | Require a PR (0 approvals, solo maintainer). Require status checks `CI (ubuntu-24.04)`, `CI (windows-2025)`, `CodeQL (actions)`, `CodeQL (javascript-typescript)`, `Dependency review`. Block force pushes and deletion. No bypass actors. | active, ruleset 24235450 |
| 3 | Ruleset "Protect version tags" (`refs/tags/v*`) | Block updates, deletion and non-fast-forward. Never move a version tag (06 §5). | active, ruleset 24235451 |
| 4 | Private vulnerability reporting | On (`SECURITY.md` points to it) | enabled |
| 5 | Dependency graph, Dependabot alerts, Dependabot security updates | On | alerts enabled; security updates enabled; the dependency graph is always on for public repos |
| 6 | Code scanning | **Advanced setup** (`.github/workflows/codeql.yml`); default setup off | default setup `not-configured` |
| 7 | Dependency review | Runs on PRs (`.github/workflows/dependency-review.yml`) | workflow present; runs once it's on a PR |
| 8 | Actions: require full-length SHA pins | On | `sha_pinning_required: true` |
| 9 | Actions: allowed actions | GitHub-owned actions plus `pnpm/*`; verified creators not allowed | `selected`, `github_owned_allowed: true`, `patterns_allowed: ["pnpm/*"]` |
| 10 | Actions: fork PR approval | Require approval for all external contributors | `all_external_contributors` |
| 11 | Actions: default `GITHUB_TOKEN` permissions | Read-only | `read` (unchanged) |
| 12 | Actions: allow Actions to create/approve PRs | Off | `false` (unchanged) |
| 13 | Secret scanning + push protection | On (free for public repos) | enabled |
| 14 | Merge methods | Squash only (PR title + body become the commit) | repo: squash on, merge commit and rebase off; "Protect main" `allowed_merge_methods: ["squash"]` |

Notes:

- The CI, CodeQL and dependency-review job names are part of the "Protect main" contract. If a
  job is renamed, update the ruleset in the same PR, or every PR is blocked on a check that
  never reports.
- `main` accepts changes only through a PR whose five required checks pass. That includes the
  owner, because there are no bypass actors. The workflows run from the PR branch, so the first
  PR that adds them can satisfy the checks.
- Adding a new third-party action needs its owner added to row 9's allowlist first, otherwise
  the run is refused.

## Owner check

- Checked by owner on: ____________ (date)
- Visibility at the time of the check: ____________
- Rows not applied, and why: ____________
