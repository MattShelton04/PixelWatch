# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
the repository's **Security** tab → **Report a vulnerability**.

Helpful details:

- affected version or commit SHA;
- which part is involved (capture template, publisher, store, viewer, PR comment);
- steps to reproduce, and the impact you expect (for example, a fork PR getting write access,
  script execution on the Pages origin, or a comment being spoofed).

## What to expect

PixelWatch is maintained by one person in their spare time. There is **no SLA**.

- I aim to acknowledge a report within 7 days and to agree a disclosure timeline with you.
- Fixes land in the latest release only. Older releases aren't patched. No release exists yet.
- Credit is given in the advisory unless you ask otherwise.

## Scope and trust model

The trust model is in [`docs/design/01-architecture-and-security.md`](docs/design/01-architecture-and-security.md)
§4. In short: capture runs untrusted PR code with read-only permissions and no secrets, and the
publisher never executes anything from the PR. Reports that break that separation are the most
important kind.

Out of scope: an adopter deliberately weakening their own workflows (for example adding secrets
to the capture workflow), and the fact that everything published to Pages is public. Both are
documented limitations.
