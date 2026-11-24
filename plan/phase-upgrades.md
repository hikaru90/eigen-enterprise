# Upgrades in a fleet of self-extending boxes

**Status:** DRAFT v2, 2026-11-23, for the owner. v1 treated company code as one milestone; the owner corrected that (quote below), so v2 is built around it. Answered by the owner: §9.1 and §9.6 (maintainer boxes merge and release, §4.1), §9.3 (update → notify the assistant → fix, §3) and §9.5 (every module is open source and shared, R6). The concept is §1–§5, the mechanics are §6, the milestones are §8. The owner's calls are in §9 and the decisions taken in planning in §10. Nothing is built yet.

**Owner's words:**
- "lets start thinking about how the different boxes will be able to upgrade themselves. who is allowed to push features and updates to the main repo to make it work for everyone? how do we avoid update incompabilities? and breaking changes? make a plan"
- "listen, we have open source software. every open source ee box can vibe code modules and extend funtionality. THIS IS WHAT WE HAVE TO HANDLE!"
- "people can vibe code modules without license. they will do so anyways. update -> notify assitant agent -> fix broken module. every module has to be open source, and i want to see what they do, they have to share their code"

**Builds on (approved):**
- `phase-extensions.md`: the core is never edited per company; extensions run in their own process behind a versioned API; there is a compatibility check before every core update.
- `phase-software-factory.md`: the box's agent builds company features into the company's repo, and core improvements go upstream as PRs.
- `plugins-boundary.md`: official plugins are only ever switched off, and a company plugin goes alongside them.

This plan makes those the centre of how upgrades work, and adds the fleet: thousands of boxes writing code.

## 1. The real problem

Every box is open source and has an AI developer living on it. So **no two boxes run the same software.** Each one is our core plus the modules its agent vibe-coded, written for people who never read code. That has three consequences, and the whole plan follows from them:

1. **Upstream can't test the combinations.** Thousands of boxes each have their own modules. Compatibility can't come from testing; it has to come from a **contract** that the core keeps and that modules can't go around.
2. **Nobody on the box can fix code by hand.** When the core moves, the **box's own agent** repairs its modules. So upstream must ship every change in a form an agent can apply.
3. **Vibe-coded code will be wrong sometimes.** A broken module must only ever break itself: not the box, not the data, not the next update.

**Where we stand today: the only way for a box to add a module is to edit the core.** Modules are compiled in (static list in `modules/index.ts`). The extension runtime (`phase-extensions.md` X0–X4) is not built, and the factory can't write code on the box yet (S2–S4). Website and Drive apps run as separate workloads, but they can't extend the OS: they have no principal and call no kernel tools. **So every box that vibe-codes a module today is a fork, and it loses our updates the moment it does.** Giving vibe-coding a place outside the core is the first job, not the last.

## 2. The model: a narrow waist

```
 ┌───────────────────────────── one box ─────────────────────────────┐
 │  modules: vibe-coded here, or installed from the catalog           │
 │   invoices · route-planner · x.acme.crm · …                        │  each: own process,
 │        │    only through the contract                              │  own principal, own data,
 │  ══════╪═══════════ core-api 1.x ══════════════════════════════    │  declared `uses:`
 │        │  tools · events · UI slots · data API · SDK               │
 │  core: a signed release, identical on every box, read-only         │
 │  data: the company data repo + Postgres                            │
 └────────────────────────────────────────────────────────────────────┘
 system.yaml pins it all: core release + every module at a commit
```

Six rules:

- **R1. The core is identical and read-only on every box.** A box runs a signed core release, and local code never edits it (approved, `phase-extensions.md`). A box running a changed core is a fork. It leaves our update channels, and Settings → Updates says so in a sentence. We can't forbid forks (Apache-2.0); we make them pointless, by making it cheap to get what a fork would have patched in (§4, extension-point requests). A fork can also come back: its agent diffs it against the release it started from and lifts the changes into modules (§8, U5).
- **R2. Modules touch the core only through the contract, `core-api`.** The contract is:
  - registry tools (input and output schemas);
  - events;
  - UI slots and the UI kit;
  - the data API;
  - the SDK generated from all of the above.

  Nothing else is reachable. A module runs in its own process, talks to the kernel over a socket with its own service principal, and keeps its data in its own folder.
- **R3. A module declares what it uses, and the kernel holds it to that.** `uses:` in the manifest lists every tool, event and slot the module touches, and a call outside it is refused. **The declaration is a lockfile that can't lie.** For every box we know exactly which parts of the contract its code depends on, so an upgrade's impact on a box is a diff, not a guess.
- **R4. The contract only grows, except through deprecations an agent can apply.**
  - Additive changes are free.
  - A breaking change is a deprecation. The old shape keeps working for 2 minor releases and 30 days, whichever is longer, and every call to it says so.
  - Each deprecation must carry **`howToMigrate`, written for agents**: old → new, with an example call. The gate refuses a deprecation without it.
  - Removing a deprecated item is a major release.
- **R5. A failing module only fails itself.** It is switched off loudly: a Needs you entry, a repair task for the assistant (§3), and a sentence on its page. The core keeps running and the module's data stays. "Off" is never silent.
  - A module switched off **because it broke** comes back on by itself once the assistant has repaired it and its tests pass.
  - A module **a person** switched off stays off. The assistant never switches it back on (the existing plugin rule).
- **R6. Every module is open source, and its code is shared (owner, 2026-11-23).**
  - Building a module needs no licence, payment or permission from us. People will vibe-code anyway, so it's free on every box, self-hosted too.
  - In return, **every module is Apache-2.0**, the same licence as the core, so any module can be adopted into the core without relicensing.
  - **Before ee runs a module commit, the box publishes that commit's source to the central hub**, signed with its install key. ee deploys only a commit the hub has given a signed receipt for. With the hub off or unreachable, no new module code deploys (the core still runs and updates). That is the enforcement.
  - **Code is shared, data never is.** A module's data folder and secrets are not part of what is published. A secret scan of the bundle (the credential-format patterns of `assert-oss-no-secrets`) refuses the publish. The assistant is told at build time that module code is public, so company content goes into module data or config, never into code.
  - **The owner sees what every module does.** The hub keeps every module's code, its manifest (`uses:`, permissions, `provides:`), every published version, and which installs run it. The hub writes a plain summary of what the module does (new text, so the LLM's job).
  - **The box's owner agrees once:** the first time a module is built on a box, one sentence says "Modules you build here are open source (Apache-2.0) and shared with eigenEnterprise", with OK.
  - Sharing Contribute *wishes* stays switch-off-able (phone-home D1–D5). Sharing module *code* doesn't.
  - Anyone who wants private module code has to fork (R1).

## 3. What an upgrade is on such a box

**An upgrade moves `system.yaml` from one consistent state to the next.** That state is the core release plus every module at a commit. The core moves first; each repaired module follows as its own `system.yaml` commit. A core rollback goes back to the previous `system.yaml`.

**The owner's flow (2026-11-23): update → notify the assistant → fix the broken module.** Modules never hold an update back.

```
 new release on the channel
   → update:   the core goes live (blue/green, health, watch; rollback = previous system.yaml).
               Only the core's own health decides the rollback, never a module.
   → check:    every module's tests run against the new core, and its `uses:` is diffed
               against the release's contract:
               ok · uses a deprecated item (works, should migrate) · broken
   → notify:   each affected module's repair task goes to the assistant of the person who
               owns the module (admins' assistant if that person is gone), plus Needs you
               for admins. A broken module is switched off loudly until it's fixed (R5).
   → fix:      the assistant repairs the module in the company's module repo, reading the
               release's `howToMigrate`, with the factory's hands. Tests green → published
               (R6) → redeployed → switched back on. One system.yaml commit.
```

**The fix is hands-off when it is safe, and asks when it widens anything.**
- **Redeploys without a click:** a repair that keeps the module's `uses:` and permissions unchanged and passes its tests. This is the new factory risk class `module-repair`.
- **Needs the module owner's approval:** a repair that needs a new tool, event, slot or permission. A module never quietly gains reach.
- **This relaxes factory D11** ("every deploy is an owner click"), for this one class only. Announced here, and the owner may veto.

**What keeps breakage rare:**
- A deprecated shape keeps working through its window (R4), so most updates break nothing and leave the assistant migrations to do within the window.
- Modules break only when a major release removes something. Majors are rare, announced in `breaking[]`, and preceded by the fleet run (§5), so their repairs can start before the release reaches the box.
- **If the assistant can't fix a module,** it stays off with its data kept. The module's owner gets a sentence saying what broke and why. If the contract lacks what the module needs, the assistant files an extension-point request (§4). It keeps trying on each new release.

## 4. Who may change what: how features reach everyone

Features travel up a ladder. Every module is on the hub from its first deploy (R6), so the ladder starts in the open. Only the last step touches `main`.

```
 built on a box ──(always published, R6)──▶ hub: every module, open ──review──▶ curated ──adopt──▶ core (main)
  its assistant builds it                    any box can install it              maintained          maintainers
       ╲
        └─ needs something the contract lacks ──▶ extension-point request ──▶ contract grows
```

| Step | Who decides | What it means |
|---|---|---|
| **Built** | the company: its assistant builds the module, and approval follows the factory's risk rules | It lives in the company's module repo, runs on that box, and is published to the hub before it runs (R6). No review from us, and it can't hurt anyone else (R1–R5). |
| **Open on the hub** | automatic | Every published module can be installed by any box. On install, that box's owner sees "community, not reviewed by eigenEnterprise" and approves the permissions the module declares. The hub's automated checks:<br>• a valid manifest;<br>• `uses:` inside the stable contract;<br>• its own tests pass on the current stable release;<br>• the secret scan. |
| **Curated** | maintainers | Reviewed by us and kept green against every release: we own its repairs and support it. The code is open like every module, so the paid tier is paid for the guarantee and support, not for the code. |
| **Core** | maintainers | Moved into `main` when broadly needed. The signals are installs across boxes, votes on the central board, and the maintainer's call. Its Apache-2.0 licence makes the move a plain merge. A box that already runs its own module for the same thing keeps it: it is never replaced (`provides:` stops two being on at once), and the assistant offers a data move as an explicit owner step. |

### 4.1 Who merges `main` (owner, 2026-11-23)

> "i am the only one that merges main. but one.eigenenterprise.app is supposed to also. so admin credential users or boxes should be able to"

- **Merging `main` is a credential, not a person.** Two kinds of holder:
  - **The owner**, from his own machine (today's practice).
  - **Maintainer boxes**: boxes the owner grants the credential to. one.eigenenterprise.app (ee-one) is the first, and for now the only one.
- **On a maintainer box, a merge to `main` is a registry action, `upstream.merge`,** so the UI, the CLI and the agent all reach it (UI parity).
  - Every call waits for approval, and **only an admin of that box** can approve it.
  - The agent and co-workers prepare the merge but never approve it, and members can't.
  - `upstream.status` (a read) shows whether the box holds the credential, what's waiting and what was merged.
- **The credential is its own GitHub App, "eigenEnterprise maintainer".** It is installed only on the core repo, with `contents: write`.
  - Its key lives in ee's secrets on maintainer boxes only.
  - Each push mints a short-lived installation token.
  - It is a different app from a company's own GitHub connection (`github.*`, which reads the company's repos). Connecting GitHub never grants core write.
  - This answers the factory's open push-credential question (`phase-software-factory.md` §8, option 1) for maintainer boxes.
- **GitHub lets exactly two actors push `main`: the owner and this App** (branch protection). Everyone else goes through pull requests.
- **The gate runs on the box**, in the factory's sandboxed build unit (S2). It is the same gate as the owner's push: `ci:local`, the contract lock and the migration lint. A push without its stamp is refused.
- **Every merge commit carries trailers:** `Approved-by: <admin>`, `Box: one.eigenenterprise.app` and the gate stamp. That is the audit trail on GitHub, and the box's activity log holds the same entry.
- **Revoking:** the owner uninstalls the App from the box (or rotates its key). `upstream.merge` then refuses with a sentence.
- **Releasing (owner, 2026-11-23: "yes, ee-one can release too").** A maintainer box may also cut a release and promote it.
  - **`upstream.release`** bumps the version and pushes the `v*` tag through the same App. CI then builds and signs as today.
  - **`upstream.promote`** moves a release from canary to stable.
  - Both wait for an admin's approval on that box, as merges do.
  - **The signing key never leaves CI and the owner's machine.** A box can ask for a release by tagging, but it can never sign one itself.
  - **Before tagging, the box runs the full release gate in its sandboxed build unit:** e2e and the upgrade rehearsal included. This makes Playwright on the box a requirement, which the factory had left for "Later".
  - **The soak and the waves bind everyone.** Promoting before the soak ends is the owner's alone.
- **Every other box is a contributor.** Its factory opens PRs (DCO, §9.2) and files extension-point requests. A maintainer merges them: the owner, or an admin on ee-one through `upstream.merge`.

**How a box's factory reaches `main`:**
- **Pull requests** for core bugs (contributor, with a DCO sign-off, §9.2).
- **Extension-point requests**: a new Contribute wish kind, `extension_point`. When a module needs a tool, event or slot that the contract lacks, the agent files one instead of patching the core, naming what it needs and why. **This is the main channel from the fleet into the core**, and it is how the contract grows where boxes actually push against it.

## 5. How upstream keeps the fleet from breaking

- **The contract is locked in the gate.** `contracts/core-api.lock.json` snapshots every tool's input and output schema, every event payload and every UI slot. The gate refuses:
  - a breaking diff that isn't a declared deprecation in `contracts/deprecations.ts`;
  - a deprecation without `howToMigrate`.

  The SDK and the OpenAPI/MCP version are generated from the lock.
- **A usage map before every deprecation, computed from the shared code.** Every module's manifest is on the hub (R6), so the hub knows exactly which contract items each module uses and which installs run it. Before deprecating anything, the maintainer sees "`contacts.get.output.company` is used by 312 modules on 140 boxes". No separate report is needed.
- **A fleet run on every release candidate, over every module in the fleet.** On canary, every published module's tests run against the candidate. That is all modules, because no module is private. The run produces:
  - **Contract breaks.** A failure means we broke the contract, which is a core bug and blocks the release, unless a deprecation ended.
  - **Repair work in advance.** For an ended deprecation, the run lists exactly which modules on which boxes will break. The hub can hand those boxes their repair tasks before the release arrives (the back-channel, U7).
- **Our own boxes go first.** Canary (ee-one, os.cerberusblue.com, demo) runs every release first, and our boxes run vibe-coded modules too. Stable rolls out in waves, and a wave halts on any rollback *or* any module breakage a box reports.
- **Schema, both levels.**
  - **Core:** releases only add. A drop or rename comes one release later in a file marked `-- ee:contract`, and that file moves the downgrade floor.
  - **Modules:** they never touch core tables. They follow the same rule in their own data.

## 6. Mechanics (carried over from v1, unchanged in substance)

### 6.1 Channels and versions

- **`canary`** (our boxes) receives every release automatically. **`stable`** gets it by promotion after the soak (24 h for a minor release, 2 h for a patch, earlier only by the owner), in waves of 10, 50, then 100 % (`rolloutPercent` exists).
- **Versions:** semver from `package.json`, plus the 12-char sha.
- **1.0 is the day `core-api` 1.0 is locked (U1) and the upgrade transaction ships (U3).** From then on, a major version means the contract lost something after its window.

### 6.2 Releases and how boxes learn about them

- **A signed channel manifest per channel**, `canary.json` and `stable.json`, kept on a fixed `channels` GitHub release. A manifest holds:
  - `release`, `version` and `issuedAt`;
  - `minFrom` and `downgradeFloor`;
  - `coreApi`;
  - `notes`, `breaking[]` and `security`.

  A box refuses a manifest older than the last one it accepted, so a replayed manifest can't hold it on a vulnerable release.
- **Managed boxes** read the manifests through the control plane, which may hold a release or set its wave.
- **Self-hosted boxes** check daily with `ee-update-check.timer`. Today they never check on their own.
- **Release signing keys:** one current key plus one offline backup key. The backup key can sign a key rotation, so losing a key strands no box. Today there is a single key and no rotation.

### 6.3 Each company decides when

- **The update policy** is set with `updates.set_policy` and read with `updates.status`, so the CLI, the agent and the UI all reach it.
  - **`auto`** in a window (default nightly 03:00 local) or **`notify`**.
  - **Channel:** `stable` or `canary`.
- **A `notify` box is never updated behind its owner's back.** After 14 days behind a security release, its banner becomes sticky.
- **Managed boxes** follow the same window.
- **A box below a release's `minFrom`** first installs the stepping-stone release that manifest names.

### 6.4 The transaction on the box (ee)

1. **Preflight.** Any failure is refused with a sentence and nothing changes. It checks:
   - the signature, `minFrom`, and the downgrade floor (on the box too, not only in /ops);
   - disk space and the capabilities the release needs (Chromium, LiveKit);
   - that no restore is running.

   Module impact is computed here for the assistant's brief. It never refuses an update.
2. **Safety copy:** the local copy as today, plus an off-box backup run when backups are configured.
3. **Migrations:** expand only, each file in a transaction. `-- ee:no-transaction` is allowed only for statements that can't run inside one.
4. **Green comes up** on the migrated schema. Health and the core smoke must pass.
5. **Cut-over, then a 30-min watch:** crash loops, the edge 5xx rate, a stalled job queue. The module tests of §3 run against the live new core. A failing module goes to the assistant; it never rolls the core back.
6. **Rollback if the watch fails:** Caddy points back at blue, which is still installed and still compatible with the schema. No restore, no lost data. The last two releases stay on disk, and `ee rollback` (plus an owner-only registry tool) refuses to go below the floor.
7. **Report:** the outcome goes to the journal, Settings → Updates, owners' Needs you on failure, and the fleet stats (§9.4).

ee upgrades itself first in the same transaction, from its own A/B slot (`/opt/ee/releases/<v>/ee.mjs` plus a symlink), and must run the previous os release. Moving Postgres or Caddy to a new major version is a separate, announced system upgrade and out of scope here.

## 7. The contracts, in one table

| Contract | Rule | Check |
|---|---|---|
| **`core-api`**: tools, events, UI slots, data API, SDK | Additive. Breaking changes only through agent-applicable deprecations (R4). `uses:` is enforced at runtime (R3). | The lock + deprecations in the gate; the fleet run on candidates (§5) |
| **Core schema** | Expand/contract; only core touches core tables | Migration lint (`-- ee:contract`); the upgrade rehearsal runs the previous release's smoke against the new schema |
| **Module data** | Owned by the module, in its own folder; same expand/contract rule; in the export | The module's own tests; the export gate |
| **Fleet protocol** (box ↔ control plane) | Tolerant reader both ways (exists); the cloud deploys first | A flow test against the previous release's protocol |
| **Hub and catalog** (box ↔ central) | The hub accepts every payload version still in the field. A module publish is signed by the install, and the receipt is signed by the hub. | A spec per past version |
| **Module code** (R6) | Apache-2.0; published before it runs; ee deploys only receipted commits | ee refuses an unreceipted commit or another licence; the hub refuses a bundle that fails the secret scan |
| **Data formats** (data repo, `system.yaml`, exports) | Readers read every older format forever; a reader refuses a newer one with a sentence (exists) | Fixtures of every past format |
| **Clients** (tabs, PWA, CLI) | The reload sentence (exists); the CLI reads the tool list from the server | Covered by `core-api` |
| **Behaviour people rely on** | No silent removals, sharpened: a removal is listed in `breaking[]` and on Settings → Updates before it reaches stable | `breaking[]` is required whenever a deprecation ends |

## 8. Milestones

| # | Milestone | Done when |
|---|---|---|
| **U0** | **Clean the floor** | • The 27 e2e specs that failed at v0.5.38 are triaged and green.<br>• `kernel.release_install` takes the full release name ee requires: it documents "the version", which gets a 400.<br>• The stale "no agent tool" notes are fixed.<br>• `CONTRIBUTING.md`, `SECURITY.md` and `CODEOWNERS` are written.<br>• The owner has set branch and tag protection on GitHub.<br>• The second signing key exists (§6.2). |
| **U1** | **`core-api` 1.0: the contract** (= extensions X0) | • `contracts/core-api.lock.json` covers tools, events and UI slots, and is enforced by the gate.<br>• `deprecations.ts` exists, with `howToMigrate` mandatory.<br>• The SDK is generated from the lock.<br>• The core contract test suite is published.<br>• The migration lint knows `-- ee:contract`, and migrations run in transactions.<br>• The upgrade rehearsal, `scripts/upgrade-rehearsal.mjs` on the test DB: the previous stable release's schema plus the demo seed, then this release's migrations, then the previous release's read smoke against the new schema. A tag needs it green, and e2e green too. |
| **U2** | **A place for vibe-coded modules, open from day one** (= X1–X3, plugins Q4/Q5, R6) | • `module.yaml` with `uses:`, `provides:`, permissions, `requires.core-api`, `license: Apache-2.0` and an owner.<br>• ee runs a module as its own process with its own principal and resource caps; the kernel enforces `uses:`; the module has its own data folder and is in the export.<br>• The declarative UI slots render.<br>• A failing module is switched off loudly (R5).<br>• **Publish before run:** the box publishes the commit (signed), the hub runs the secret scan and returns a signed receipt, and ee deploys only receipted commits. There is a one-time owner OK.<br>• **The hub's modules view for the owner:** code, manifest, versions, which installs run each module, and a summary of what it does.<br>• **Proof:** the box's assistant vibe-codes a small real module (e.g. invoices) into the company repo without touching the core. People and the agent use it, and the owner reads its code on the hub. |
| **U3** | **The upgrade transaction** | §6.4 in full, including the module check after cut-over (it never rolls the core back). The previous `system.yaml` is the rollback. Every failure path has an ee spec. |
| **U4** | **Update → notify the assistant → fix** (= X4, needs factory S2–S4) | • After each update, the module check of §3 runs, and each affected module's task goes to its owner's assistant.<br>• The assistant repairs from `howToMigrate`.<br>• The `module-repair` risk class redeploys without a click; a repair that widens anything waits for the module owner.<br>• A repaired module is published and switched back on.<br>• The impact is shown on Settings → Updates and the module's page.<br>• **Proof:** a deprecation in a real release is migrated by the assistant on a canary box with no human writing code, and a deliberately broken module is switched off, repaired and back on by itself while the core keeps running. |
| **U5** | **Forks come home** | `ee` detects a core that differs from its signed release and says so. The agent diffs a fork against the release it started from and lifts the changes into modules, plus extension-point requests for what the contract can't do yet. |
| **U6** | **Channels and self-upgrade** | §6.1–6.3: signed manifests, canary auto-land, soak and promotion, waves halting on rollbacks and module breakage, `updates.*` tools, the daily check, the window. |
| **U8** | **Maintainer box: ee-one merges `main` and releases** (needs factory S2–S4, Playwright on the box) | • The "eigenEnterprise maintainer" GitHub App exists, and its key is in ee-one's secrets.<br>• Branch protection lets only the owner and the App push `main`; tag protection lets only the owner and the App push `v*` tags.<br>• `upstream.merge`, `upstream.release` and `upstream.promote` are admin-approved, with the full gate run on the box; `upstream.status` is the read.<br>• Merge commits carry trailers, and revoking works.<br>• **Proof:** an admin on ee-one approves a factory-built change, it lands on `main` with trailers, and an admin cuts a release that CI signs and canary installs, and the same call from a member, from the agent alone, or from another box is refused. |
| **U7** | **Install from the hub, fleet run, back-channel** | • Any box installs a published module, with the automated checks of §4 and the permission approval.<br>• The curated tier.<br>• The usage map computed from the shared manifests.<br>• The fleet run over every module on every release candidate.<br>• The hub → box back-channel that hands out repair tasks before a release lands.<br>• The `extension_point` wish kind on the central board. |

**Order:**
1. U0.
2. U1.
3. U2 and U3 in parallel: they touch disjoint files, kernel/modules and `ee/src` respectively.
4. Factory S2–S4, then U4 and U8 in parallel: U4 touches the repair loop, U8 touches upstream, GitHub and ee secrets.
5. U5 and U6 in parallel.
6. U7.

**Why U1 and U2 come first:** until vibe-coded code has a place outside the core, every box that extends itself is a fork. Nothing in U3–U7 can help a fork.

## 9. The owner's calls

1. ~~Who besides you may merge `main`?~~ **Answered (owner, 2026-11-23):** the owner, plus admins on maintainer boxes, ee-one first (§4.1).
2. **Outside code: DCO or CLA?**
   - **Answered for modules (owner, 2026-11-23):** no licence or agreement is needed to build one. Every module is Apache-2.0 and shared (R6).
   - **For pull requests to the core:** DCO sign-off (decision, owner may veto).
3. ~~A module the agent can't repair blocks an update?~~ **Answered (owner, 2026-11-23):** no. Update → notify the assistant → fix the broken module (§3).
4. **Upgrade outcome reports from boxes** (release, from, step, ok/fail) → **answered 2026-11-24: on by default, with a switch** in Settings → Updates. A box with the switch off still upgrades, but a wave can't halt on its failures. The report carries no company data. Contract usage needs no report, because it comes from the shared code (§5).
5. ~~Community catalog open or curated only?~~ **Answered (owner, 2026-11-23):** every module is open source and shared; the hub holds all of them (R6, §4).
6. ~~Release tags yours alone?~~ **Answered (owner, 2026-11-23):** ee-one can release too (§4.1).

## 10. Decisions taken in planning (orchestrator, logged; owner may veto)

- **One contract for official plugins and company modules** (plugins Q4), versioned `core-api` 1.0, with `uses:` enforced at runtime.
- **Company code runs out of process only** (plugins Q5, as approved in extensions X1). No in-process company code.
- **Deprecation window:** 2 minor releases and 30 days, whichever is longer. `howToMigrate`, written for agents, is mandatory.
- **Modules never hold an update back** (owner: "update -> notify assitant agent -> fix broken module"). Only the core's health decides a rollback. A broken module is switched off loudly, and its owner's assistant repairs it.
- **New factory risk class `module-repair`:** it redeploys without a click when `uses:` and permissions are unchanged and the tests pass. Anything that widens a module waits for the module owner. This relaxes factory D11 for this one class (announced).
- **Every module is Apache-2.0 and published before it runs** (owner: "every module has to be open source … they have to share their code").
  - ee deploys only commits the hub has receipted. With the hub off, no new module code deploys, so the hub becomes critical infrastructure and needs its own uptime.
  - Code is shared; data and secrets never are.
  - Wishes sharing stays switch-off-able; code sharing doesn't.
- **Modules are free to build on every box; the curated tier is paid for the guarantee and support, not the code.**
- **Channels:** two, `canary` and `stable`. Soak 24 h / 2 h. Waves halt on rollbacks and module breakage.
- **The signed channel manifest is monotonic.** The control plane narrows it (hold, wave) but never widens trust.
- **Rollback goes to blue and the previous `system.yaml`, not to a restore.** Restore is the manual last resort.
- **A fork leaves the channels** and is told so plainly. U5 gives it a way back.
- **1.0** = U1 + U3 shipped.
- **Maintainer boxes (from the owner's answer, §4.1):**
  - Merging `main` is a credential held by the owner and by maintainer boxes.
  - On a box, every merge needs an admin's approval.
  - The credential is a separate GitHub App with `contents: write` on the core repo only.
  - Admins on maintainer boxes may also release (`upstream.release`) and promote (`upstream.promote`); the signing key stays in CI and with the owner.
  - Skipping the soak is the owner's alone.
