# Phase: Workspace — replace Microsoft Teams for the owner's company

**Status:** APPROVED direction (owner, 2026-11-03). Decisions W-1…W-6 below; W-7 (navigation names) is a recommendation the owner can veto.
**Owner direction (2026-11-03):** "The system on the server has to run with a company that I own … something for the team members to chat inside … roles and team management … a way for artifacts and files to be viewed by people in the company, something like Google Drive … I want to move away from Teams. A chat, user roles, a drive and maybe an editor to edit the files directly in place."
**Must follow:** `plan/phase-cohesion.md` §1 (one shell, one page frame, settings on the module page), AGENTS.md (TDD, fail loud, no silent removals), D16 (no new services: everything runs natively in the eigenEnterprise process + the one Postgres).

## 1. Owner decisions (2026-11-03)

- **W-1 Editor:** no Word/Excel/PowerPoint editing, ever. **Everything text-shaped lives as Markdown** and is edited in place. Tables are **CSV**, edited in place as a grid. Drawings: **Excalidraw** (owner said "Exodus"; interpretation to confirm) — optional, after the Markdown editor. Other files (PDF, images, Office files people upload) are previewed where the browser can and otherwise downloaded.
- **W-2 Chat v1:** channels (public/private) + direct messages (1:1 and small groups); threads; reactions; edit/delete own messages; files attached in chat land in the Drive. Real-time, unread counts, push notifications. **No @agent in channels in v1.**
- **W-3 Teams:** **groups/departments** (e.g. Sales, Dev). Roles stay Owner / Admin / Member; access to a private channel or a Drive folder is granted to people, groups, or everyone in the company.
- **W-4 Sign-in:** invite link + **passkey** now (the owner copies the invite link into a message; the member opens it, registers a passkey and signs in with it from then on). Email codes work once SES is set up — later.
- **W-5 Storage (orchestrator decision, D16):** file bytes on the server's disk under the workload's state dir (`${EE_STATE_DIR}/drive`, content-addressed, survives blue-green), metadata + permissions + revisions in Postgres. Markdown/CSV documents keep a revision history (every save is a revision; restore a revision). No new service.
- **W-6 Co-editing v1:** one editor at a time per document (visible "X is editing" lock with takeover), autosave, revision history. Live multi-cursor co-editing is a later milestone.
- **W-7 Navigation (recommendation):** the team chat is **Messages**, the Drive is **Drive**; the company agent's chat at `/` is renamed **Assistant** so there are never two things called "Chat". Nav: Messages, Drive, Assistant, Overview, Website, Email, Brand, Agent, Memory, Settings.

## 2. Shared contract: access (built first in T1, consumed by Chat and Drive)

`src/lib/server/access/` — one model for "who may see/change this":
- `Grant = { resourceType: 'channel' | 'folder' | 'file', resourceId, subject: { kind: 'user', userId } | { kind: 'group', groupId } | { kind: 'company' }, level: 'view' | 'edit' | 'manage' }`
- `canAccess(userId, resourceType, resourceId, level): Promise<boolean>` — owner/admin always `manage`; otherwise the strongest grant via user, any of the user's groups, or company. Folder grants inherit to children (Drive resolves the folder chain; the access module takes the chain as input).
- `listGrants`, `setGrants` (manage-level only), every change audited as a kernel event.
- Fail closed: unknown resource, unknown user or group → no access.

## 3. Milestones

Each: tests first, gates green, one commit per workstream, an e2e journey with **two or more browser contexts as different members**, screenshots inspected, a progress entry. Migration numbers assigned up front: T1 **0107**, Drive **0108**, Chat **0109**.

- **T1 — Team: groups, roles, invites, access** (module `members`, Settings → Members & invites): groups CRUD (name, members), the access contract (§2), invite flow verified end to end with **invite link → passkey registration → sign in with passkey** (no email), roles Owner/Admin/Member with clear explanations, remove member (their sessions end).
- **D1 — Drive core** (new module `drive`, system module, `/drive`): folders and files, upload (drag-and-drop, multiple, size limit), download, rename, move, delete to trash + restore; share a folder/file with people, groups or everyone (access contract); preview: Markdown (rendered), CSV (table), images, PDF, text; "New → Document (Markdown) / Table (CSV)"; search by name; storage per W-5.
- **D2 — Editors:** Markdown editor in place (WYSIWYG over Markdown — the file stays plain `.md`), CSV grid editor in place; autosave, revisions + restore, edit lock per W-6. Later: Excalidraw (stored as `.excalidraw` JSON) once W-1's interpretation is confirmed.
- **C1 — Messages core** (new module `messages`, system module, `/messages`): channels (public/private; private via access contract with people/groups), DMs, real-time delivery (SSE; Postgres LISTEN/NOTIFY so both blue-green slots deliver), unread counts per channel, push notifications (existing push service), message history with pagination.
- **C2 — Messages depth:** threads, reactions, edit/delete own messages (deleted = "message deleted"), attachments → Drive (a channel gets its own Drive folder with the channel's access), file previews inline.
- **W-7 rename** (with C1): Assistant at `/`, nav entries Messages and Drive.
- **Proof on the test server:** owner + two invited members (passkeys via a virtual authenticator) chat in a channel and a DM, share a folder with a group, edit a Markdown doc, see the revision history.

Order: **T1, D1, C1 in parallel now** (T1 owns the access contract; D1 and C1 code against §2 and adapt at merge); then D2 and C2; then the proof run.

## 4. Out of scope (named)

Video/voice calls and meetings (Teams' other half — a later phase, needs a decision on WebRTC/TURN), calendar, Word/Excel editing (W-1), @agent in channels (W-2), external guests, mobile apps (the PWA works on phones), migration of existing Teams data (export/import — later, if wanted).

## 5. Risks

- **Backups:** company files now live on one server. Off-box backups (phase-substrate "later") become urgent before real use — flagged to the owner.
- **Real-time across blue-green:** two slots run briefly during a deploy; LISTEN/NOTIFY keeps both delivering; tested.
- **Storage growth:** a per-file size limit and a visible storage total in Drive; no quota system in v1.
