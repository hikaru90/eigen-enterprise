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
