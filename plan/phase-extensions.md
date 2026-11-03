# Phase: Extensions — company features without forking the core

**Status:** APPROVED (owner, 2026-11-03: "sounds good — I don't like the WordPress model, but we have no other choice").
**Why:** if each company's software factory edited eigenEnterprise's own source, every company would run a fork and every upstream release would be a painful merge. Rule: **the core is never edited per company.** Company features are extensions; core improvements go upstream as pull requests and reach every company with the next release.
**Not WordPress — the three things that make WordPress painful are designed out:** extensions never patch core code (no hooks into internals), never touch the database directly (only a typed API + their own data folder in the company data repo), and never run in the core's process (own process, deployed by ee — phase-substrate S7). Plus an automatic compatibility check before every core update.

## 1. The three layers (all in git)

| Layer | Changed by | Repo | Updates |
|---|---|---|---|
| Core (eigenEnterprise) | upstream only | the official repo, semver releases | ee installs a new release; no merge |
| Extensions | the company's factory or developers | the company's **extensions repo** (private GitHub) | owned by the company; no merge with core |
| Data | the app and its people | the company **data repo** (`plan/phase-git-native.md`) | file formats versioned; the core ships migrations |

`system.yaml` in the data repo pins the running system: core version (release + commit) and each extension with its version and commit. A restore installs exactly that (git-native §8).

## 2. The extension contract (versioned: Extension API 1.x)

- **Manifest** (`extension.yaml`): id, name, version, `requires: { core-api: "^1.4" }`, the module(s) it adds, tools, UI slots, data scopes, runtime from the catalog (D16), needed permissions.
- **Runtime:** its own process, deployed by ee as a workload (S7); it talks to the core only through the kernel API over a local socket with its own service principal (permission-checked, audited, approval-gated like any tool).
- **Tools:** registered through the kernel registry (the agent and people use them exactly like core tools).
- **UI slots:** a module entry in the nav, a module page (`/x/<id>/…`), a settings section on its own page, an Overview tile, an Activity source. UI is built from the shared component set and page frame — declarative schemas (lists, detail, forms, boards, charts) rendered by the shell, so extensions look like the rest and follow the brand style; an escape hatch (a sandboxed iframe with the design tokens) only when a schema can't express it.
- **Data:** its own folder in the data repo (`extensions/<id>/…`), plain or encrypted per access scope via the git-native API; indexed through the same adapter framework. No direct SQL.
- **Events:** subscribe to core events (message posted, file changed, member joined) through the kernel, at-least-once, idempotent handlers.

## 3. Upgrades

1. A new core release is announced (Overview: "Update available").
2. The factory checks out every installed extension against the new core in a sandbox: the extension's own tests + a contract test suite shipped with the core + a smoke run.
3. Broken extension → the factory repairs **the extension** (never the core) and shows the change for approval.
4. Only when all pass is the update offered; the owner clicks; ee installs core + extensions blue-green, data migrations run expand/contract (D15), `system.yaml` is committed with the owner as author. Rollback = the previous `system.yaml`.

## 4. Milestones

- **X0 — Contract:** manifest schema, Extension API 1.0 (kernel socket protocol, service principal, tools, events), semver + compatibility rules, the core's contract test suite.
- **X1 — Runtime:** ee deploys an extension as a workload from the extensions repo at a commit (S7), registry proxying, permissions, audit.
- **X2 — UI slots:** declarative module page/settings/overview/activity schemas rendered by the shell; the sandboxed iframe escape hatch.
- **X3 — Data:** extension data folders on the git-native framework (after G0).
- **X4 — Upgrade check:** compatibility run before a core update, results on Overview.
- **Proof:** a small real extension (e.g. "Contacts / CRM") built by the factory into the extensions repo, installed, used by the agent and people, survives a core update, and is restored with the company from git.

## 5. Interaction

- **Factory** (`phase-software-factory.md`): builds into the extensions repo; core changes become upstream PRs (amended there).
- **Git-native** (`phase-git-native.md` §8): `system.yaml`, format versions.
- **Substrate S7** (out-of-process modules) is X1.
