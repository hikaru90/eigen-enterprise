# Security policy

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
[hikaru90/eigen-enterprise](https://github.com/hikaru90/eigen-enterprise/security/advisories/new).
Please don't open a public issue or pull request for it.

Include:
- what is affected (the core, `ee`, a module, the hub);
- the release (`ee upgrade --check` or Settings → Updates shows it);
- the steps to reproduce;
- what an attacker gains.

We confirm receipt within 3 working days and tell you what we plan to do within 10.

## What is supported

Security fixes go into the newest release. Settings → Updates offers it, and `ee upgrade` on the server
installs it. We don't backport fixes to older releases. If you run an old release, update.

Automatic updates through the `canary` and `stable` channels are being built (U6 in
[`plan/phase-upgrades.md`](plan/phase-upgrades.md)). Once they ship, a fix that is marked `security` cuts
the soak short, but the rollout still runs in waves.

A box whose core was changed locally is a fork. We can't ship fixes to a fork. Its agent can lift its
changes into modules and bring it back onto the update channels.

## How releases are protected

- Every release's `SHA256SUMS` is signed with an Ed25519 release key, and `ee` and `install.sh` refuse
  anything else. Signing happens only in CI. A second, offline backup key is also trusted, so a lost or
  leaked key doesn't strand any box.
- `main` and the `v*` tags are protected: only the owner and the maintainer GitHub App can push them.
- Module code is published to the hub before it runs. A secret scan refuses any publish that contains
  credentials. A module's data and secrets are never published.
