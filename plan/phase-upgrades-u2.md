# U2 contract: a place for vibe-coded modules, open from day one

Part of [`phase-upgrades.md`](phase-upgrades.md) §8 U2. **Fixed 2026-11-24** (orchestrator; the owner may veto the decisions in §10). Streams A, B and C build against this contract in parallel; D and E follow. The shared files of §9.0 land first, in one commit. After that, no stream edits another stream's files.

## 1. What exists and is reused

- **Modules today** are static TypeScript and run in process:
  - `ModuleManifest` is in `src/lib/kernel/modules.ts`, validated by `manifestSchema` in `manifest-schema.ts`.
  - They are compiled into `moduleManifests` in `modules/index.ts`.
  - `toolNamespaces` lets a module id own a differently spelled namespace; `contribute-hub` → `contribute_hub` already does.
  - `registerModuleTools` in `wiring.ts` is the only path in. Nothing can unregister a tool or register one after boot.
- **Tool calls:** `KernelRegistry.execute` runs activation gate → roles → approval → input → handler → output → audit → vcs. Module tools go through it unchanged, as proxy descriptors.
- **Switching off:** `moduleSwitchedOff`, the rule that a person's "off" stays off, is reused as is. Activations are only `{moduleId, active}`, so the runtime state ("off because broken") is new (§4.6).
- **Principals:** `kernel_principals` already allows kind `service` with `apiKeyHash`. `ToolPrincipal.via` is only `'brain'` today. The brain's rule ("acts only as a person") is the model for modules.
- **The U1 contract:**
  - `contracts/core-api.lock.json`, `CORE_API_VERSION`, `CORE_EVENTS` and `CORE_UI_SLOTS = []`.
  - The generated SDK, whose transport is JSON-RPC `tools/call` over `/api/mcp`.
  - U2 adds a second transport over the module socket. The SDK types stay unchanged.
- **How ee runs code:**
  - `renderUnit` in `ee/src/units.ts` gives DynamicUser `ee-<name>`, a fixed `HARDENING` block, MemoryMax/CPUQuota, SocketBindDeny and an EnvironmentFile.
  - Builds run in a transient `ee-build` unit (`reconcile.ts`).
  - A `release` tarball source is checked by sha256.
  - Workloads already have `tier: 'module'`.
  - Verbs live in `daemon.ts`. The previews sub-router, with its snapshot hand-off through `${PATHS.osState}/previews/`, is the pattern §5 copies.
  - Release trust is `trustedReleaseKeys`; the hub key copies it.
- **The hub:**
  - Installs hold an Ed25519 install key, sealed under `TENANT_MASTER_KEY` (`modules/contribute/share/identity.ts`).
  - Requests are signed as `v1\nMETHOD\npath\nts\nsha256(body)` (`share/contract.ts`).
  - The hub service handles register, authentication, the replay guard and 60 requests/h, and parses strict zod bodies. Its routes are `src/routes/api/hub/**`. `scripts/mock-hub-core.ts` speaks the hub API.
- **Data:**
  - `system.yaml` v1 has `extensions[{id,version,commit}]`, and nothing writes it in production.
  - `extensionDataPrefix(id)` → `extensions/<id>/` is already reserved.
  - Backups carry `company-data` and `company-keys`. The export streams `files/…`.
- **Other reuse:** the secret patterns `OSS_FORBIDDEN_KEY_PATTERNS` and `OSS_OPERATOR_SECRET_KEYS`, the deterministic `writeTarGz` (`modules/drive/tar.ts`), and zod's `z.fromJSONSchema`.

## 2. `module.yaml` v1 (`contracts/module-manifest.ts`, pure zod, strict)

```yaml
manifest: eigen.module/1            # literal
id: invoices                        # ^[a-z][a-z0-9]*(-[a-z0-9]+)*$, 2–24; not a core module id, not kernel|core|eigen|ee|os
name: Invoices                      # 1–60
version: 0.1.0                      # MAJOR.MINOR.PATCH
description: Write and send invoices.   # 1–300
license: Apache-2.0                 # literal; the bundle must also contain LICENSE
requires: { core-api: "^1.0.0" }    # caret range only, satisfiable by the box's CORE_API_VERSION
runtime: { node: "22" }             # catalog runtime
build: [["npm","ci"],["npm","run","build"]]   # argv[], ≤16, ee's build unit (network: npm registry only)
test:  [["npm","test"]]             # argv[], ≥1; after build, no network, no secrets
start: ["node","dist/index.js"]
resources: { memoryMb: 256, cpuPercent: 50 }  # 64–1024 (256) · 10–100 (50)
uses:                               # the lockfile that can't lie (R3)
  tools:  [contacts.get, email.send_mail]     # each in core-api.lock.json
  events: [contacts.created]                  # each in CORE_EVENTS
  slots:  []                                  # each in CORE_UI_SLOTS (empty until D)
provides:
  tools:
    - name: create                  # ^[a-z][a-z0-9_]{0,40}$ → registered as x_<id_>.create
      summary: Create an invoice
      input:  { type: object, ... } # JSON Schema 2020-12 (z.fromJSONSchema accepts it)
      output: { type: object, ... } # required
      auditClass: mutate            # read | mutate | external
      approvalRisk: internal        # required unless read
      approval: mode                # none | mode | always
      roles: [admin, member, agent] # ⊂ {admin, member, agent}; default all three
      activity: "Created invoice {output.number} for {input.customer}"  # required unless read; placeholders only
      timeoutMs: 30000              # ≤120000
  events: [{ name: sent }]          # emitted as x_<id_>.sent; payload JSON Schema optional
  slots: []                         # [{ slot, id, title, view }]; view defined by stream D
permissions:
  background: false                 # may act without a caller, as its owner (§4.3)
  secrets: [STRIPE_API_KEY]         # ≤10 env names; values set by an admin
  network: []                       # must be [] in v1
  capabilities: []                  # catalog capability names
```

Exported from the same file:
- `kernelModuleId(id) = "x-"+id`, `toolNamespace(id) = "x_"+id.replaceAll("-","_")` and `workloadName(id) = "mod-"+id`;
- `canonicalManifestJson`, `manifestSha256`, `satisfiesCoreApi(range, version)` and `MODULE_MANIFEST_FILE`.

## 3. Where module code lives

- **One module repo per box, separate from the data repo:** a git working tree at `$EE_STATE_DIR/module-repo/`, with one folder `<id>/` per module. The folder holds `module.yaml`, `LICENSE`, the code, its tests and `vendor/eigen-sdk/`.
  - Only the kernel writes it, through the `modules.*` tools, and the acting principal is the author.
  - It has no remote in U2, because the hub holds every published version.
- **A module commit is `{id, commit}`**, with a 40-hex commit. The bytes are pinned by `bundleSha256` (§6.1), and the display form is `invoices@3f9a0c12be47`.
- **`system.yaml` v2:** `modules: [{ id, version, commit, bundleSha256 }]` replaces `extensions`.
  - A v1 file still reads, with `extensions` mapped to `modules` without a bundle.
  - The kernel commits it to the data repo once ee reports `running`, authored by the deployer. A removal is a commit too.
  - ee's `workloads/mod-<id>.json` is the operational truth; `system.yaml` is what a restore pins.
- **Backups:** `module-repo` and ee's bundle store `/var/lib/ee/modules` join `eeState`. On restore, a bundle missing locally is re-fetched from the hub by sha256.

## 4. Runtime protocol kernel ↔ module (`eem/1`, `contracts/module-protocol.ts`)

**4.1 Transport**
- **Socket:** the kernel listens on `$EE_STATE_DIR/modules/<id>/run/kernel.sock`, mode 0666. ee bind-mounts that *directory* to `/run/ee-module`, so the socket survives a blue/green cut-over of the os.
- **Framing:** NDJSON, one JSON-RPC 2.0 message per line, at most 4 MiB, UTF-8.
- **Connection:** one per module, opened by the module and used in both directions. The module never listens.
- **Reconnect:** the SDK retries every 1 s for 120 s, then exits non-zero. A newer `hello` replaces the older connection.

**4.2 Authentication**
- The first message must be `hello {protocol:"eem/1", moduleId, commit, token}`. Anything else gets `module_protocol` and the connection closes.
- `EE_MODULE_TOKEN` is 32 random bytes, new on every deploy. `sha256(token)` is stored in `kernel_principals {id:"module:<id>", kind:"service", roles:[]}`.
- The path, the token and the commit must all match.
- The answer is `{coreApi, heartbeatMs:10000, grants:{background, secrets}}`. Then the module sends `ready {}`, which is the moment it counts as running.

**4.3 Module → kernel**

| Method | Params | Result / errors |
|---|---|---|
| `tools.call` | `{name, input, callId?}` | `name` ∈ `uses.tools`, else `module_use_undeclared`. With `callId`, it runs as the invoking person (`via:'module'`). Without it, only if `permissions.background`, as the module's owner; else `module_no_person`. Then the normal registry path: `permission_denied`, `approval_required`, `invalid_input`, `module_inactive`. |
| `events.emit` | `{name, payload}` | `{id}`. `name` ∈ `provides.events`, with the payload validated if a schema is declared. Stored as `x_<id_>.<name>`. |
| `data.get` | `{path}` | `{content, etag}`, or `data_not_found` |
| `data.put` | `{path, content, ifMatch?}` | `{etag}`, or `data_conflict` / `data_quota` |
| `data.list` | `{prefix?, cursor?}` | `{items:[{path, etag, size}], cursor}` |
| `data.delete` | `{path, ifMatch?}` | `{}` |
| `heartbeat` | `{}` | `{}`, every `heartbeatMs` |

How data is stored:
- Paths are relative to `extensions/<id>/` in the company data repo, checked with `assertRepoPath`.
- A file holds JSON or a string, at most 1 MiB, and at most 200 MiB per module.
- Writes go through gitstore, authored by the acting principal.
- This is the module's only persistence.

**4.4 Kernel → module**
- `tool.invoke {callId, tool, input, principal, deadlineMs}` returns the output. Input and output are validated against the receipted manifest. A call past its deadline gets `module_timeout`.
- `event.deliver {deliveryId, event}` returns `{}` as the ack. Delivery is at-least-once and in order per module, with the cursor in `kernel_module_event_cursor`. Retries back off for up to 24 h, then the event is dropped with a journal line. Handlers are idempotent on `event.id`. Only types in `uses.events` are delivered.
- `shutdown {reason}` gives the module 10 s to exit.

**4.5 Proxy tools**
- Each provided tool becomes a `ToolDescriptor`:
  - `name x_<id_>.<tool>` and `module x-<id>`;
  - its schemas via `z.fromJSONSchema`;
  - its activity rendered from the template;
  - `approval:'mode'` puts it in the gated set dynamically, and `'always'` sets `approvalAlways`.
- The handler sends `tool.invoke` to the module. With no live session it fails with `module_not_running {module, state, sentence}`.
- They are registered at boot from `kernel_modules`, and again on any deploy whose `provides` changed (a new `unregister`).
- **`ModuleRegistry.register` refuses any non-module manifest owning a namespace that starts with `x-`/`x_`,** so module tools can never shadow core tools.
- Proxy tools reach MCP, the CLI and OpenAPI like any tool. They are not in `core-api.lock.json`, which is the core's contract only.

**4.6 State, health and "switched off loudly" (R5)**
- **Table `kernel_modules`:** `id, owner_user_id, manifest, receipt, commit, bundle_sha256, state, reason, state_since, first_deployed_at`.
  - `state` is one of `unpublished | publishing | deploying | connecting | running | failed | off`.
  - A person's intent stays in `kernel_module_activations`. **A module is on when its activation is true and its state is running.**
- **What counts as failing:**
  - (a) ee reports `failed`;
  - (b) no `ready` within 60 s;
  - (c) no heartbeat for 30 s;
  - (d) 3 or more restarts in 10 min;
  - (e) 5 protocol violations or invalid outputs in 10 min.

  A plain tool timeout is not a failure.
- **A failing module is switched off:**
  - state `failed`, with a sentence;
  - the kernel tells ee to stop it, with reason `failed`, and emits `module.failed`;
  - a Needs you entry for the module's owner and the admins: "Invoices is switched off because it stopped answering. Its data is kept.";
  - the same sentence on the module page;
  - data is never touched.
- **Back on:**
  - **By itself:** a new commit that builds and tests green and sends `ready` makes it `running` and emits `module.recovered`, unless a person's activation is `false`.
  - **By an admin:** `kernel.module_activate` on a failed module retries the same commit.
- **A person's off:** `kernel.module_deactivate` sets the activation false and the state `off`, has ee stop it with reason `person`, and emits `module.switched_off`.
  - Only a person switches it back on.
  - Deploying a new commit while it's off records the commit but doesn't start it.
- **New `CORE_EVENTS`:** `module.published`, `module.deployed`, `module.failed`, `module.recovered`, `module.switched_off`, `module.switched_on`, `module.removed`.
- **New error codes:** `module_use_undeclared`, `module_not_running`, `module_timeout`, `module_protocol`, `module_no_person`, `module_unreceipted`, `module_sharing_not_accepted`, `module_needs_admin_click`, `hub_unavailable`, `data_not_found`, `data_conflict`, `data_quota`. On the wire, each is JSON-RPC `-32000` with `data: {code, message, detail}`.

**4.7 SDK (stream A)**
- `contracts/sdk/module-runtime.ts`: `defineModule({tools, events})`, speaking `eem/1`.
- `contracts/sdk/module-transport.ts`: a `CoreApiTransport` over the session.
- `contracts/sdk/test-kernel.ts`: an in-memory kernel built from the lock that enforces `uses:`.
- Scaffold copies all three into `<id>/vendor/eigen-sdk/`.

## 5. ee ↔ kernel API for module workloads (`contracts/module-workload.ts`; ee implements it in `ee/src/modules.ts`)

**Bundle hand-off:**
1. The kernel writes `${PATHS.osState}/module-bundles/<id>-<sha12>.tar.gz`.
2. ee accepts a bundle only from there, checks its sha256, copies it to `/var/lib/ee/modules/<id>/<bundleSha256>.tar.gz` (root, 0600) and deletes the kernel's copy.
3. It keeps the last 3 per module.

| Verb | Body | Answer |
|---|---|---|
| `POST /v1/modules` | `{ id, version, commit, manifest, receipt, tarball, sha256, token, author, dryRun? }` | `202 { module }`. `422 urn:ee:receipt_invalid {detail}`, `422 urn:ee:catalog_gap {missing}`, `409 urn:ee:module_busy`. The same id replaces the running one, stop-then-start. With `dryRun`, it only builds and tests: `{passed, log}`. |
| `GET /v1/modules` | — | `200 { modules: ModuleView[] }` |
| `GET /v1/modules/:id` | — | `200 { module }`, or `404 urn:ee:module_not_found` |
| `POST /v1/modules/:id/stop` | `{ author, reason: 'person'\|'failed', sentence }` | `200 { module }` |
| `POST /v1/modules/:id/start` | `{ author }` | `202 { module }` |
| `GET /v1/modules/:id/logs?lines=200` | — | `200 { lines }` (redacted) |
| `DELETE /v1/modules/:id` | `{ author }` | `200 { module }`. The data stays in the data repo. |
| `POST /v1/secrets` (exists) | `{ workload:'mod-<id>', name, value }` | `403` when `name` isn't in the receipted `permissions.secrets` |

```ts
type ModuleRunState = 'building' | 'testing' | 'starting' | 'running' | 'failed' | 'stopped'
type ModuleView = {
  id: string; workload: string            // mod-<id>
  version: string; commit: string; bundleSha256: string
  desired: 'running' | 'stopped'; stopReason: 'person' | 'failed' | null
  state: ModuleRunState; error: string | null   // a sentence
  restarts: number; since: string
  releases: { commit: string; bundleSha256: string }[]   // last 3, newest first
}
```

**ee behaviour:**
- **Desired state:** `workloads/mod-<id>.json` is `tier:'module'` with a `release` source and a contract derived from the manifest. A `module:{id, receipt, manifest, desired}` field is allowed only on that tier. **The receipt is checked again on every reconcile.**
- **Build:** the existing sandboxed build.
- **Test:** a second transient unit as `ee-build`, with `PrivateNetwork=yes`, no env file, the module's memory and 10 minutes at most. A failure leaves the previous release running.
- **The run unit:**
  - `User=ee-mod-<id>` with the full HARDENING block;
  - no network (`PrivateNetwork=yes`, `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`);
  - no StateDirectory, `HOME=/tmp`, the release read-only, and the socket directory bind-mounted;
  - memory and CPU from the manifest, capped at 1024M and 100 %.
- **Env, exactly this:** `EE_MODULE_ID`, `EE_MODULE_COMMIT`, `EE_MODULE_SOCKET=/run/ee-module/kernel.sock`, `NODE_ENV=production` and `PATH`, plus an EnvironmentFile with `EE_MODULE_TOKEN` and the declared secrets that have a value. `EE_API_URL`, `DATABASE_URL` and company env join `RESERVED_ENV`.
- **Health:** ee's gate is "active, NRestarts < 3, for 10 s". The kernel decides real liveness (§4.6).
- **Restarts:** after a reboot, ee starts again every module whose desired state is `running`.
- **Journal:** `module.built`, `module.test_failed`, `module.running`, `module.failed`, `module.stopped`, `module.removed`.
- **Hub trust:**
  - `settings.moduleHub {origin, publicKeys[]}` lives in the company repo.
  - It is set only by root's `ee bootstrap --module-hub <origin> [--module-hub-key <spki>]`, never by a control verb.
  - The default is the official origin plus the embedded keys in `ee/src/hub-key.ts`, written by `scripts/hub-key.sh`, current plus backup.
  - ee renders `MODULE_HUB_URL` into the os env.
- **The kernel without ee** fails loud: "Running modules needs the eigenEnterprise server (ee)".

## 6. Publish before run

**6.1 Bundle** (`contracts/module-bundle.ts`)
- **What it is:** the git tree of `<id>/` at `commit`, written with `writeTarGz`.
- **It is deterministic:**
  - entries are sorted, regular files and directories only;
  - no links, absolute paths or `..`;
  - modes are 0644/0755, uid/gid 0, mtime = the commit time and gzip mtime 0.
- **Limits:** ≤5,000 files, ≤20 MiB unpacked and ≤8 MiB packed.
- **It must contain** `module.yaml` and `LICENSE`, and a lockfile when there are dependencies.
- **It must not contain** `node_modules/`, `.git`, `.env*`, `*.pem`, `*.key` or `id_*`. The kernel refuses to commit those in the first place.

**6.2 Hub endpoints** (signed like contributions; register reuses `/api/hub/register`)

| Endpoint | Body | Answers |
|---|---|---|
| `POST /api/hub/modules/publish` | `{v:1, module_id, version, commit, bundle_sha256, manifest, bundle_b64, core_api, app_version}` | `201 {receipt}`. `200` with the same receipt for the same install, id and bundle. `409` for the same commit with another bundle. `413`. `422 {problems:[{check, path?, line?, message}]}`. Plus the existing 400/401/403/429. |
| `GET /api/hub/modules/bundles/:sha256` | — (signed) | `200` bundle bytes, for a restore |
| `PUT /api/hub/modules/:module_id/run` | `{v:1, bundle_sha256, state}` | `200`: which installs run it |

**What the hub checks** (every problem is collected):
1. The bundle parses, and its sha256 matches.
2. Its `module.yaml` parses and equals `manifest`.
3. The licence is Apache-2.0, and `LICENSE` is present.
4. The core-api range is satisfiable by both the hub and the box.
5. Every `uses` item is in the hub's lock. Deprecated items are allowed and listed in `deprecatedUses`.
6. **The secret scan:** the credential-format patterns, PEM private-key headers, and non-empty assignments to `OSS_OPERATOR_SECRET_KEYS`. A finding reports path:line, never the value.

The hub never runs module code. Tests run on the box (§5).

**6.3 Receipt** (`contracts/module-receipt.ts`)

```ts
type ModuleReceiptV1 = {
  v: 1; kind: 'eigen.module-receipt'
  hub: string; keyId: string            // first 16 hex of sha256(hub SPKI)
  installId: string; moduleId: string; version: string; commit: string
  bundleSha256: string; manifestSha256: string
  coreApi: string; license: 'Apache-2.0'; deprecatedUses: string[]
  issuedAt: string
  signature: string     // base64 Ed25519 over "eigen.module-receipt.v1\n" + canonical JSON of the other fields
}
```

- `signReceipt(fields, pkcs8b64)` and `verifyReceipt(r, trustedSpki[])`.
- The hub's key is the `MODULE_HUB_SIGNING_KEY` ee secret on the hub box.
- In U2 a receipt never expires; revoking comes in U7.

**6.4 What ee verifies** (all of it, or `422 urn:ee:receipt_invalid` naming the first failure):
- the signature, under a trusted hub key;
- the module id, commit and version;
- `bundleSha256` against the tarball, and `manifestSha256` against the manifest;
- that the manifest parses and its licence is Apache-2.0;
- that the tarball holds `module.yaml`.

`installId` is not checked, so U7 can install a module built on another box.

**6.5 With the hub off,** `modules.publish` fails with `hub_unavailable`: "The module hub can't be reached, so new module code can't run yet. Everything already running keeps running." With `MODULE_HUB_URL` unset, it says "module hub not configured". There is no bypass.

**6.6 The one-time OK.**
- The first scaffold or publish on a box raises a Needs you entry for the owner: **"Modules you build here are open source (Apache-2.0) and shared with eigenEnterprise."** [OK]
- `modules.accept_sharing` (owner, as a person) stores `{by, at}`. Until then, publish fails with `module_sharing_not_accepted`; scaffold and edits still work.
- The scaffold README and the assistant's instructions say that module code is public.

## 7. The hub's modules view for the owner (on the central box, module `module-hub`)

- **Tables** (migration in stream C):
  - `hub_modules (install_id, module_id, name, latest_bundle_sha256, first/last_published_at)`;
  - `hub_module_versions (bundle_sha256 PK, install_id, module_id, version, commit, manifest, core_api, uses, provides, permissions, files, bytes, deprecated_uses, receipt, published_at, summary, summary_at)`;
  - `hub_module_runs (install_id, module_id, bundle_sha256, state, reported_at)`.
- **Bundles** are stored at `$EE_STATE_DIR/module-hub/bundles/<sha256>.tar.gz`. Revoking an install hides its modules from the listing and keeps the code.
- **Summary:**
  - After a publish, a job queue job asks the LLM through the gateway (cost tracked) what the module does, what it touches and what it sends out.
  - Its input is the manifest plus up to 60 KB of source: the entry file first, then by size.
  - Summarising is new text, so it is the LLM's job.
- **Read tools** (admin and agent on the hub box; Contribute → Modules at `/contribute/modules`):
  - `module_hub.list {query?, cursor?}`, `module_hub.get {install_id, module_id}`, `module_hub.version {bundle_sha256}`, `module_hub.tree {bundle_sha256}`, `module_hub.file {bundle_sha256, path}`;
  - `module_hub.summarize {bundle_sha256}` (mutate, admin).

## 8. Registry actions (box side, module `company-modules`, namespace `modules`; Settings → Modules is a client of these)

| Tool | Class | Who | Notes |
|---|---|---|---|
| `modules.list` | read | admin, member, agent | State, sentence, version, owner |
| `modules.get {id}` | read | admin, member, agent | Manifest, commit, receipt, hub link, sentence |
| `modules.status {id}` | read | admin, agent | ee's view plus the kernel session |
| `modules.logs {id, lines?}` | read | admin, agent | |
| `modules.source {id, commit?, path?}` | read | admin, member, agent | Tree or file |
| `modules.scaffold {id, name, description}` | mutate | admin, agent | Manifest template, LICENSE, vendored SDK, a passing test. The box-side owner is the calling person. |
| `modules.write_file` / `delete_file` | mutate | admin, agent | Inside `<id>/` only; refuses the forbidden files of §6.1 |
| `modules.commit {id, message}` | mutate | admin, agent | Returns `commit` |
| `modules.publish {id, commit}` | external | admin, agent | Not approval-gated. Needs the sharing OK. |
| `modules.test {id, commit}` | mutate | admin, agent | Publishes if needed, then an ee dry run |
| `modules.deploy {id, commit}` | mutate, gated | admin, agent | **A first deploy, or one that widens `uses`/`permissions`/`provides` roles, needs an admin as a person** (otherwise `module_needs_admin_click` plus Needs you). Otherwise it follows the approval mode; U4's `module-repair` relaxes this. |
| `modules.remove {id}` | mutate, approvalAlways, destructive | admin, as a person | Code and data stay |
| `modules.accept_sharing {}` | mutate | owner, as a person | §6.6 |
| `kernel.module_activate` / `deactivate` | (exist) | unchanged | For `x-<id>` (§4.6) |
| `substrate.secret_set` | (exists) | admin | Workload `mod-<id>`; ee refuses undeclared names |

## 9. Stream split

**9.0 Contract commit (before any stream).**
- `contracts/module-manifest.ts`, `module-receipt.ts`, `module-protocol.ts`, `module-bundle.ts` and `module-workload.ts`, each with a spec. They import only `zod` and `node:*` (no `$lib`, no relative imports), so ee can import them.
- `contracts/fixtures/modules/hello/`: `module.yaml` providing `greet` and using `members.list`; `LICENSE`; a `package.json` with no dependencies; `index.mjs` speaking raw `eem/1`; `test.mjs`.
- `contracts/fixtures/module-hub-test-key.ts`, a test-only key pair named as such.
- Empty `companyModulesManifest` and `moduleHubManifest` wired into `modules/index.ts`.
- Migration numbers reserved: A `0179_company_modules`, C `0180_module_hub` (0178 was taken by demo guest access).

**Stream A: kernel module host and the box's Modules module.**
- **Owns:**
  - `src/lib/kernel/module-host/**`;
  - edits to `modules.ts`, `registry.ts` (unregister, dynamic gating), `principals.ts`/`types.ts` (`via:'module'`), `errors.ts`, `event-catalog.ts` and `manifest-schema.ts` (the `x-` guard);
  - `contracts/sdk/module-*.ts`, `test-kernel.ts`, and the regenerated lock and SDK;
  - `modules/company-modules/**` except `publish/`;
  - the module methods of `src/lib/server/ee/client.ts`;
  - `gitstore/system.ts` (v2), `kernel.schema.ts` and migration 0179;
  - the Settings → Modules routes;
  - the Needs you source in `overview/dashboard.ts`;
  - the export of `extensions/<id>/`;
  - the `ui-parity.ts` entries.
- **Stubs:** a fake `PublishPort` that signs with the fixture key; a fake ee that spawns `hello/index.mjs`.
- **Done when:**
  - hello connects, and `x_hello.greet` works through `registry.execute`, MCP and the CLI;
  - calling an undeclared tool gives `module_use_undeclared`;
  - a core manifest can't own `x_*`;
  - a heartbeat miss makes the module `failed`, with ee stopped, `module.failed` emitted, a Needs you entry and the data intact;
  - a new commit brings it back to `running`;
  - after a person's off, the agent's activate is refused;
  - a background call without the permission gives `module_no_person`;
  - events are delivered at-least-once across a reconnect;
  - the export holds `files/extensions/hello/…`;
  - `system.yaml` v2 round-trips, and v1 still reads.

**Stream B: ee module workload.**
- **Owns:**
  - `ee/src/modules.ts`;
  - edits to `daemon.ts` (the `/v1/modules` router), `spec.ts`, `units.ts`, `reconcile.ts` (the module path), `paths.ts`, `company-repo.ts` (`moduleHub`), the bootstrap/main flags, `secrets` and `backup/box.ts`;
  - new `ee/src/hub-key.ts` and `scripts/hub-key.sh`;
  - `ee/e2e/box.sh`;
  - their specs.
- **Stubs:** fixture-key receipts; the hello bundle from `contracts/module-bundle.ts`.
- **Done when:**
  - hello runs as `ee-mod-hello` within the existing `systemd-analyze security` threshold;
  - from inside the unit, TCP fails, `/var/lib/ee-state/os` is unreadable and only `/run/ee-module` is visible;
  - a tampered tarball, receipt, manifest or key gives 422 and no unit;
  - a failing test leaves the previous release live;
  - stop, start and logs work, and the module comes back after a reboot;
  - the bundles are in the backup;
  - an undeclared secret gives 403.

**Stream C: hub publish, receipts, the modules view, and the box's publish client.**
- **Owns:**
  - `modules/module-hub/**`;
  - `src/routes/api/hub/modules/**` and `src/routes/(nucleus)/contribute/modules/**`;
  - migration 0180;
  - `scripts/oss-operator-secret-keys.mjs` (exports `scanSecrets`);
  - `scripts/mock-hub-core.ts` and `mock-hub.ts`;
  - `modules/company-modules/publish/**` (the `PublishPort`).
- **Done when:**
  - publishing hello gives a 201 receipt that `verifyReceipt` accepts, and publishing it again gives 200 with the same receipt;
  - 409, 413 and 422 each name their check: a planted `sk-…` is reported with path:line and no value; a wrong licence, a `uses` outside the lock and a manifest that differs are refused;
  - a replay gives 401 and a revoked install 403;
  - the owner's view lists the module and shows its code, versions, the installs running it and its summary;
  - the box client completes the round trip against the mock hub, and a stopped hub gives `hub_unavailable`.

**Order:** 9.0 first, then A, B and C in parallel. The orchestrator then integrates them with a box e2e: scaffold → write → commit → publish (mock hub) → deploy → `ee x_hello.greet` → kill the module → a failed Needs you entry → a new commit → back on.

**Stream D (after A): UI slots.**
- `CORE_UI_SLOTS`: `nav.entry`, `page` (at `/x/<id>/<page>`), `settings.section`, `overview.tile`, `activity.source`.
- The `view` schema: list, detail, form, board and chart, each bound to a provided tool.
- Shell renderers, and the regenerated lock.
- **Done when** hello's page and tile render from its manifest alone.

**Stream E (after D): the proof.** The assistant builds `invoices` using only the `modules.*` tools. The owner gives the sharing OK, and an admin clicks the first Deploy. People and the agent then use it, and the owner reads its code and summary on the hub. Nothing in the core changes.

## 10. Decisions (orchestrator, 2026-11-24; the owner may veto)

- **D1** The module repo is separate from the data repo: public code and private data never share a tree.
- **D2** Ids are local slugs, and the hub identity is `(installId, id)`. There are no global names to squat.
- **D3** The `x-`/`x_` prefix makes shadowing core tools impossible by construction.
- **D4** **A deviation from the U2 row, which says "an owner in module.yaml":** the owner is a box-side record. Code is published, and a person is data.
- **D5** A module always acts as a person: the caller, or its owner in the background. It never holds rights of its own (the brain's rule).
- **D6** No network egress in U2. Outbound goes through core tools. A host allowlist would come later, as `permissions.network`.
- **D7** A module persists only through `data.*` in `extensions/<id>/`, so its data is automatically in backups, the export and git history.
- **D8** ee runs only receipted bytes, for build, test and run. Work-in-progress commits get published too, which is the cost of R6.
- **D9** The SDK is vendored per module at scaffold time, so a bundle is self-contained.
- **D10** Modules deploy stop-then-start in a single slot, with one session per module.
- **D11** The hub key can only be changed from ee's root CLI, so the os can't widen trust.
- **D12** The repair task goes to the assistant in U4. U2 emits `module.failed` and the Needs you entry.
- **D13** A first deploy, or one that widens reach, needs an admin's own click. Other redeploys follow the approval mode.
- **D14** Only caret ranges for `requires.core-api`.
- **D15** The hub's module code can be read by the hub box's admins (the owner and maintainers) in U2. Public browsing for anyone comes with U7. The code is Apache-2.0 either way, so this only decides how soon it can be browsed.
