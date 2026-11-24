# Contributing to eigenEnterprise

eigenEnterprise is Apache-2.0. There are two ways to add to it, and you can do either without asking us:
write a **module**, or send a **pull request to the core**.

The full model is in [`plan/phase-upgrades.md`](plan/phase-upgrades.md). This page is the short version.

## Modules: build anything, share the code

- You need no licence, payment or permission to build a module. Your box's assistant can build one for you.
- **Every module is Apache-2.0, and its code is shared.** Before a box runs a module commit, it publishes that
  commit's source to the eigenEnterprise hub. **Data and secrets are never published**, and a secret scan
  refuses the publish. Keep company content in the module's data or config, never in its code.
- A module reaches the core only through the versioned contract, `core-api`: registry tools, events, UI
  slots and the data API. Its `module.yaml` lists what it `uses:`, and the kernel refuses anything else.
- When an update breaks a module, the module is switched off loudly and the box's assistant repairs it,
  following the release's `howToMigrate` notes. A module never holds an update back.
- If the contract lacks what your module needs, file an **extension-point request** on the Contribute
  board. Don't patch the core. A box running a changed core is a fork and leaves the update channels.

> **Status:** the module runtime (U1–U2 in the plan) is being built. Until it ships, modules live in
> `modules/` in this repository and reach the core through pull requests.

## Pull requests to the core

1. **Sign off every commit** (DCO): `git commit -s`. That adds
   `Signed-off-by: Your Name <you@example.com>`, your statement that you may contribute the change under
   Apache-2.0 ([developercertificate.org](https://developercertificate.org/)). We need no CLA.
2. **Follow [`AGENTS.md`](AGENTS.md).** The binding rules include:
   - tests first;
   - no fallbacks or silent degradation;
   - no string heuristics for meaning;
   - every UI action is a registry tool too;
   - a schema change needs both the SQL migration and its journal entry;
   - every model call goes through the gateway.
3. **Run the gate:** `npm run ci:local`. This is the only test gate, since GitHub Actions runs no tests.
4. **Contract changes:** additions are free. A breaking change is a deprecation. The old shape keeps
   working for 2 minor releases and 30 days, whichever is longer. Every deprecation carries
   `howToMigrate`, written so an agent can apply it.
5. **Migrations** are expand/contract. A column or table is dropped only in a migration marked
   `-- ee:contract`, one release after nothing reads it any more.

## Who merges and releases

- `main` and the `v*` release tags are protected. Only the owner and the "eigenEnterprise maintainer"
  GitHub App can push them. The App is held by maintainer boxes, which today means one.eigenenterprise.app,
  where an admin approves each merge or release.
- Releases are signed in CI. A maintainer box can request a release by pushing its tag, but it can never sign one.
- Every release runs on our own boxes first and then rolls out to other boxes in waves.

## Security

Please don't open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).
