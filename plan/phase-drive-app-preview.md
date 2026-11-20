# Drive: run a web app folder and see it in the Drive (approved 2026-11-20)

Owner, 2026-11-20: "an option for seeing node packages or repos that were added to the drive that
obviously are web apps using a framework … a simple way to do npm run dev or something like this to
display those in the drive." Status: **approved 2026-11-20** (owner: "Yes, build it": Run is admins only; previews get a
wildcard DNS name `*.preview.<console host>`). (Its sibling,
HTML files rendered as pages, shipped the same day: `progress.md`.)

## What it is

A Drive folder with a `package.json` gets a **Run** button. Run copies the folder as it is now
onto the box, installs its dependencies, starts its `dev` script, and shows the running app in a
frame on the folder page, at its own address. **Stop** ends it, and so does 30 minutes without a
viewer. **Restart** picks up files changed in Drive since. One click from "the repo is in Drive" to
"I'm clicking around the app". No terminal, no Docker.

## What we build on (research 2026-11-20)

- **Folders already upload** (`drive-browser.svelte`, `webkitdirectory`), so a repo dragged in
  keeps its tree. GitHub-synced repos don't count: they hold only Markdown, never code
  (`plan/github-drive.md`, owner decision 2026-11-12).
- **ee already builds and runs untrusted app code safely.** A build runs in a capped transient unit
  as `ee-build`: NoNewPrivileges, ProtectSystem=strict, its own dir, MemoryMax, 20 min max
  (`ee/src/reconcile.ts:95-130`). An app runs as its own user, can't reach other apps' files or
  databases, and is served by Caddy (`phase-substrate.md` §6). Node comes from the catalog (22).
- **Release sources are tarballs ee checks by sha256** (`spec.ts releaseSource`). A Drive folder
  snapshot fits that shape.

## Shape

```
Drive folder page ──Run──▶ kernel action drive.app_run (human only, D11)
   └ snapshot: the folder's files → tarball (skips node_modules, .git) → ee POST /v1/previews
ee: unpack → npm ci (capped build unit, registry network only) → start `npm run dev`
    in a preview unit (own user, MemoryMax 1 GB, no DB, no secrets, no company env)
    → watch which port the unit's process listens on → Caddy: <id>.preview.<console host> → that port
Drive folder page ◀── status (installing · starting · running · failed + log tail) ── ee
   └ frame: https://<id>.preview.<console host>   (its own origin: no app cookies)
```

## Decisions I've made (they go in the decision log on approval)

- **A web app means a `package.json` with a `dev` script** (falling back to `start`). That's a file
  fact, the same way an extension decides a preview, so it isn't framework detection (a substrate
  non-goal) and isn't a heuristic for meaning. A lockfile is required (`npm ci`), and pnpm/yarn
  lockfiles go through corepack. With no lockfile the app fails loud with "add a lockfile", never a
  silent `npm install`.
- **We never pass framework flags.** ee sets `PORT` and `HOST=127.0.0.1`, then **watches which
  port the unit actually opens** (its cgroup's listening sockets). Vite, Next, SvelteKit, Astro and
  Express all work without us knowing which is which. Caddy rewrites `Host` to `localhost` so dev
  servers' host checks (Vite `allowedHosts`) pass, and proxies websockets so hot reload works.
- **Its own origin per preview** (`<id>.preview.<console host>`), never a path under the app.
  Running code must not share the company OS's cookies or storage.
- **A snapshot, not a live mount.** The preview runs a copy. Restart takes a new copy. Live sync
  of Drive edits into a running dev server is a later step.
- **Resource limits:** one running preview per box (a small VPS), and 1 GB of memory. Installs
  reuse ee's npm cache. Previews stop after 30 minutes idle and on Stop, and they never start on
  boot. A preview is not an app: it has no database, no secrets, no company email or queue, and
  no backups.
- **Registry actions first:** `drive.app_run`, `drive.app_stop`, `drive.app_status`, so the
  CLI, MCP and the agent get them too. Run is human-only, like a deploy. The agent may read
  status and logs, so it can help fix a failing start.
- **Next step, not this one:** "Keep it running → make it an app". That hands the folder to the
  Website module's existing Connect-a-repo flow with a build/start contract filled in.

## Owner decisions (2026-11-20, were open questions)

1. **Who may press Run?** → **Admins only.** It runs uploaded code on the
   company's server, sandboxed like apps but still code. The other option is anyone who can edit
   the folder.
2. **The address needs a wildcard DNS record** (`*.preview.<your console host>`) pointing at the
   box. Caddy then gets each certificate on demand. On the managed box we set this up ourselves. A
   self-hosted box needs one DNS record from you. → **Accepted.**

## Milestones (each: tests first, then the box)

- **P1, ee:** `/v1/previews` start/stop/status, the snapshot tarball, install + dev unit, port
  watch, Caddy route, idle stop. *Proof:* the box runs a Vite and a SvelteKit fixture folder, and
  both answer through their preview host. A fixture that reads another app's files or opens a
  host port is refused.
- **P2, kernel + Drive:** the three actions, the folder snapshot (with skips and a size cap), the
  Run / Stop / Restart controls with the status and log tail on the folder page, and the preview
  frame. *Proof:* an e2e run uploads a Vite folder, clicks Run, sees its page in the frame, edits
  a file, Restarts, and sees the change.
- **P3:** "Make it an app" hands it to the Website module.

## Risks

- **Install time and size:** a fresh `npm ci` for a Next app is 1–3 minutes and hundreds of MB.
  The npm cache helps from the second run on. The status shows each step, so a long install
  doesn't look stuck.
- **Native postinstall scripts** run inside the build unit, sandboxed. Ones that need system
  libraries outside the catalog fail with their own log.
- **Dev servers that ignore `HOST`** and bind 0.0.0.0 are still unreachable from outside: the unit
  has no host ports, and the firewall stays shut.

## Contract between ee and the kernel (fixed 2026-11-20, both streams build against it)

**Preview id:** `pv` + the first 12 hex characters of sha256(Drive folder id), e.g. `pv3f9a0c12be47`
(regex `^pv[0-9a-f]{12}$`). It's stable per folder, so restarts keep the same host and certificate
(Let's Encrypt rate limits). The kernel computes it, and ee only validates it.

**Host:** `<id>.preview.<console host>` (e.g. `pv3f9a0c12be47.preview.os.example.com`). On a
`.localhost`/`.test` console host, Caddy's internal issuer covers it, as for the console today.

**Snapshot hand-off:** the kernel writes a gzip tarball of the folder (paths relative to the folder
root, regular files only, without `node_modules/` and `.git/`, at most 200 MB unpacked and 20,000
files) to `$EE_STATE_DIR/previews/<id>-<unix ms>.tar.gz`. On the box `$EE_STATE_DIR` is
`/var/lib/ee-state/os` (`PATHS.osState`). ee accepts a tarball only under
`${PATHS.osState}/previews/`, checks its sha256, copies it into its own dir and deletes the
kernel's copy.

**Control API (ee/src/daemon.ts, JSON, like every verb):**

| Verb | Body | Answer |
|---|---|---|
| `POST /v1/previews` | `{ id, tarball, sha256, folderName, author }` | `202 { preview }`. `409 urn:ee:preview_busy { running: PreviewView }` when another id is active (not stopped/failed). Same id: restart (stop, then start from the new tarball). |
| `GET /v1/previews` | — | `200 { previews: PreviewView[] }` |
| `GET /v1/previews/:id` | — | `200 { preview }`, `404` unknown |
| `POST /v1/previews/:id/seen` | `{}` | `200 { preview }`. Resets the idle clock (the Drive calls it while someone has the preview open). |
| `DELETE /v1/previews/:id` | `{ author }` | `200 { preview }` (state `stopped`), and its files are removed |

```ts
type PreviewState = 'installing' | 'starting' | 'running' | 'failed' | 'stopped'
type PreviewView = {
  id: string                 // pv…
  folderName: string         // for "another preview is running: <name>"
  state: PreviewState
  host: string               // <id>.preview.<console host>
  url: string                // https://<host>/
  script: 'dev' | 'start' | null   // null until package.json was read
  startedAt: string          // ISO
  lastSeenAt: string         // ISO
  error: string | null       // why it failed / stopped (e.g. "idle for 30 minutes", "no lockfile")
  log: string[]              // last 200 lines: install + dev server output
}
```

**ee behaviour:**
- **Install:** `npm ci` (or `pnpm install --frozen-lockfile` / `yarn install --immutable` through
  corepack, picked by which lockfile is present), in a capped transient unit like the build unit.
  It runs as user `ee-preview` with network on, MemoryMax 1 GB and 15 minutes at most. No lockfile
  → `failed`, "add a lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock)".
- **Run:** the `dev` script, else `start`, else `failed` ("package.json has no dev or start
  script"). It runs as transient unit `ee-preview-<id>` with user `ee-preview`, NoNewPrivileges,
  ProtectSystem=strict, ProtectHome, PrivateTmp, PrivateDevices, ReadWritePaths = its own dir only,
  and MemoryMax 1 GB. The env is `PORT=<free port 41000–41999>`, `HOST=127.0.0.1`,
  `NODE_ENV=development` and the catalog Node 22 on PATH: no company env, secrets, DB or kernel
  socket.
- **Port watch:** within 5 minutes, ee finds the TCP port a process of the unit's cgroup listens
  on (cgroup.procs ∩ `ss -ltnpH`). The first one wins, and preferably 127.0.0.1. If none appears,
  the preview is `failed` with the log.
- **Caddy:** route `<host>` → `reverse_proxy 127.0.0.1:<port>`, with `Host` rewritten to
  `localhost:<port>` and websockets passed through. The route lives in memory, not in the company
  repo: `caddy.ts` renders the active previews alongside the desired routes.
- **Stop:** on DELETE, after 30 minutes since `lastSeenAt` (checked every minute), and on ee start
  (every leftover `ee-preview-*` unit is stopped and the preview dirs are wiped). Previews are never
  restored after a restart.
- **Journal:** `preview.started`, `preview.running`, `preview.failed` and `preview.stopped`, each
  with the author when known.

**Kernel (P2):**
- **Actions:** `drive.app_status {folder_id}` (read; any role that can view the folder; also
  returns `webApp`); `drive.app_run {folder_id}` (human-only and admin-only, like a deploy:
  snapshot → `POST /v1/previews`); `drive.app_stop {folder_id}` (human-only, admin-only).
- **Detection, `webApp`:** `{ script: 'dev'|'start', lockfile: string|null } | null`, from the
  folder's own `package.json` (top level only): valid JSON with `scripts.dev` or `scripts.start`.
  It's a file fact. `lockfile: null` is shown as a reason Run will fail, so Run isn't silently
  hidden.
- **Folder page:** admins see **Run app** when `webApp` is set. Once it's started, a panel shows
  state, the log tail, **Stop**, **Restart**, **Open in new tab** and a frame on `url` (sandbox
  `allow-scripts allow-same-origin allow-forms allow-popups`: it's its own origin, so same-origin
  is its own, not the OS's). While the panel is open, the page polls `drive.app_status` (which
  calls `/seen`) every 5 s while installing/starting and every 30 s while running.
- **Without ee** (`SubstrateUnavailableError`), Run fails loud: "Running apps needs the
  eigenEnterprise server (ee)". Never a fake success.
