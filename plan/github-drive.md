# GitHub repos in Drive: read-only, kept in sync with a fine-grained token (approved 2026-11-12)

Owner, 2026-11-12: "we need a way to integrate github repos into the drive … read only … the
context of the branches and the work inside of the drive for eigen enterprise to know what is going
on in the github repos … a personal access token as read only." Status: **approved; S0–S4 merged on main (not pushed, not on the box); S5 open.**

**Owner decisions (2026-11-12):**
- **Read-only, through a fine-grained personal access token** the owner creates on GitHub and pastes
  in. eigenEnterprise never writes to GitHub.
- **Visibility:** every connected repo's Drive folder is visible to **the whole company, view
  only**. Admins can narrow a folder with normal Drive sharing.
- **Contents:** generated pages (Overview, Branches, Pull requests, Activity) **plus README and the
  Markdown docs** from the default branch. No code files.
- **AI summary:** after a sync that found changes, the assistant writes a short "What's going on"
  summary per repo (one gateway call, cost tracked). No call when nothing changed.

## Where we start (research 2026-11-12)

- **Drive has no read-only or external concept.** There are no `source` or `readonly` columns, and
  no unique `(parent, name)`, so an upserting writer needs its own path→id map. Names can't contain
  `/` (`modules/drive/service.ts:154`). The closest precedent is the Messages attachment folders
  (synthetic owner `'messages'`, special-cased in `pathFor`, `describeItems` and the archive
  filter, `service.ts:304,488,788`). Every write goes through `allows()` / `requireItem`
  (`service.ts:254-284`). Owner and admins always get `manage`, and an agent actor gets everything
  (`service.ts:254`), so grants alone can't make a folder read-only.
- **The Drive rail is hardcoded** (`src/lib/drive/sections.ts`): `driveSection` throws on an
  unknown path root, so a new root has to be registered there.
- **Drive isn't indexed.** The assistant sees Drive only when it calls `drive.list` / `drive.read`.
  The orchestrator prompt (`modules/orchestrator/brain.ts:300-313`) never mentions Drive, and there
  is no retrieval step. Folders alone won't make the assistant "know"; see §6.
- **GitHub client:** `modules/website/github/api.ts`. `repo()`, `branches()` and `lastCommit()`
  already take a token. It has no ETag/304, no `Link` paging, no timeout, no `retry-after`, and no
  commits, PRs, tree or contents endpoints. The boundary check (`src/lib/kernel/boundaries.ts`, no
  exceptions allowed) forbids another module importing it, so it moves to `src/lib/server/github/`.
- **The `github.*` tool namespace** belongs to the Website module's deploy tools
  (`modules/website/github/manifest.ts`).
- **Secrets:** the house pattern for a credential someone pastes in is the Amazon SES one: an
  admin-only route, a live check with the provider, then the value sealed in the app database
  (`src/lib/server/crypto/envelope.ts`, AES-256-GCM, key derived from `TENANT_MASTER_KEY`; the
  GitHub App credentials in 0085 do the same). ee's secret store can't be read back and redeploys
  on every change, so it's the wrong home. **Approval requests store raw tool input**
  (`src/lib/kernel/registry.ts:147-153`), so the token must never pass through a tool or the chat.
- **No poller exists.** The job-queue tick (`src/lib/server/job-queue/tick.ts`, every 60 s) with a
  module-owned jobs table claimed `FOR UPDATE SKIP LOCKED` is the pattern (email's `mail_jobs`).
  During blue-green both slots tick, hence the row locks.
- **No webhooks for this.** A read-only token can't create a repo webhook (that needs Webhooks:
  write). The existing `/api/github/webhook` serves only the GitHub App.
- **The ee mirror** exists only for deployed apps, holds one branch, and has no log or branch
  endpoints. It's not a source for this.

## Shape

```
owner ──paste token──▶ /m/repos (admin only) ──GET /user, /user/repos──▶ GitHub   (live check)
                         │ seal (envelope.ts) → repo_source_tokens
                         └ tick the repos to sync → repo_sources
job-queue tick (60 s) ─claim due repo (SKIP LOCKED)─▶ GET-only client, ETags ─▶ GitHub REST
   └▶ snapshot (repo, branches, commits 30 d, PRs, README + *.md on the default branch)
       └▶ render (pure: snapshot → Markdown files) ─▶ DriveSourcePort.upsert (content changed only)
            └▶ changed? ─▶ gateway: summary JSON ─▶ Overview.md "What's going on"
                         └▶ kernel event repos.synced
Drive: GitHub / <owner> / <repo> /  Overview.md · Branches.md · Pull requests.md · Activity.md · Docs/…
       read-only for everyone (agent included), view grant for the whole company
assistant: prompt block "Connected GitHub repos" + repos.list + drive.read
```

## 1. The token

- **What the owner creates on GitHub** (the page shows these steps with a link to
  `github.com/settings/personal-access-tokens/new`):
  - Resource owner: your account, or the organisation that owns the repos.
  - Repository access: **Only select repositories**.
  - Permissions: **Metadata: read** (GitHub adds it), **Contents: read**, **Pull requests: read**.
    Nothing else.
- **One token covers one GitHub owner** (an account or one org), so the page allows several
  tokens, each labelled with its owner.
- **Paste → live check, admin only**, through a page route like SES's `/api/onboarding/mail`. Never
  a kernel tool, never the chat, never an approval.
  - `GET /user` checks that the token works.
  - The token's expiry date is read from GitHub's response header and stored.
  - The page lists the repos the token can see (`GET /user/repos`, paged).
  - **Classic tokens are refused.** They can write to every repo the person can, which breaks
    "read-only". Message: "This is a classic token, which can change every repo you can. Create a
    fine-grained token with read-only access instead."
- **Read-only in our code too.** A fine-grained token's permissions can't be read from the API, so
  the token client accepts `GET` only and throws on any other method.
- **Storage:** `repo_source_tokens` stores the token sealed with
  `sha256('repo-source-token:' + TENANT_MASTER_KEY)`, AAD = the token row id. Also the GitHub
  owner, the last 4 characters, the expiry, and who added it. The page shows `…a1b2`, the owner and
  the expiry, never the token. Logs carry the token id only.
- **Expiry:**
  - 7 days before, the page shows a warning and admins get a notice.
  - Once expired, every repo on that token stops with "The GitHub token for `<owner>` expired on
    `<date>`. Create a new one and paste it here."
  - There's no anonymous retry. **Replace token** swaps in a new one, and the repos keep syncing.
- **Remove token** (the admin's own click, with a confirm that says so): deletes the token, stops
  its repos, and deletes their Drive folders. They're derived copies.

## 2. Picking repos

- The page lists every repo the token can see, with a checkbox each; ticked repos sync. Archived
  repos on GitHub are marked.
- **Unticking deletes that repo's Drive folder**, and the confirm says so.
- Repos are keyed on GitHub's **numeric repo id**, so a rename survives and the folder is renamed
  on the next sync.
- **Status per repo:** last synced, next due, last error in plain words, and a **Sync now**
  button.

## 3. Sync

- **Table:** `repo_sources` holds, per repo, the token id, repo id, full name, default branch,
  `due_at`, `claimed_by`/`claimed_until`, ETags per endpoint, branch heads, blob shas of copied
  docs, and the last error.
- **Claiming:** due repos are claimed on the existing job-queue tick (`FOR UPDATE SKIP LOCKED`).
  Each repo is due **every 15 minutes**, and Sync now makes it due immediately.
- **Every request is conditional** (`If-None-Match` with the stored ETag). GitHub doesn't count a
  304 against the 5,000/h limit, so an idle repo costs almost nothing.
- **One run:**
  1. `GET /repos/{o}/{r}`: description, default branch, `pushed_at`, archived flag.
  2. `GET /repos/{o}/{r}/branches` (paged): heads.
  3. For each branch whose head moved, `GET /repos/{o}/{r}/commits?sha=<branch>&since=<30 days ago>`
     (at most 100 per branch). Ahead/behind against the default branch comes from
     `GET /repos/{o}/{r}/compare/<default>...<branch>`, for branches with commits in the window.
  4. `GET /repos/{o}/{r}/pulls?state=all&sort=updated&direction=desc`, paged until older than 30
     days.
  5. Docs: `GET /repos/{o}/{r}/git/trees/<default head>?recursive=1`, then every `.md`/`.mdx` file.
     A blob is fetched (`/git/blobs/{sha}`) only when its sha changed.
- **Doc limits:**
  - At most 300 files, 256 KB each and 10 MB per repo.
  - Files over a limit aren't copied. Overview.md lists them under "Not copied (size limit)".
  - If GitHub truncates the tree, Overview says only part of the docs were copied.
  - Nothing is dropped silently.
- **Rate limit:**
  - Below 500 remaining, the run stops and resumes after the reset. The page shows "Paused until
    14:05 (GitHub's rate limit)".
  - `retry-after` is honoured for GitHub's secondary limits.
- **Errors:**
  - A 401 stops every repo on that token ("the token no longer works").
  - A 403/404 on one repo stops that repo ("the token can no longer see `<repo>`").
  - GitHub's raw error goes to the server log (redacted) and the error `cause`, never to the page.

## 4. What lands in Drive: `GitHub / <owner> / <repo> /`

- **Overview.md:**
  - Starts with **What's going on**: the AI summary, labelled as written by the assistant, with its
    time.
  - Then the description, a link, the default branch, the last push, and the open PR count.
  - Then branches active in the last 30 days, and "Not copied" if any docs hit a limit.
- **Branches.md:**
  - Every branch: last commit (short sha, author, date, subject), ahead/behind the default branch,
    and its open PR.
  - Branches with no commit in 90 days are in a second table, "Quiet branches".
- **Pull requests.md:**
  - Open PRs: number, title, author, head → base, draft, created/updated, labels, requested
    reviewers, and the first 1,500 characters of the description.
  - Then PRs merged or closed in the last 30 days.
- **Activity.md:** the last 30 days, newest first, grouped by day and then by branch: subject,
  author, short sha (linked).
- **Docs/…:** README and the Markdown files of the default branch, verbatim, at their repo paths.
  Path segments become a chain of folders (a segment never contains `/`). The file view shows "From
  GitHub · `<branch>` @ `<sha>` · read-only" instead of anything being written into the content.
- **How files are written:**
  - All files are `text/markdown`, so `drive.read` works on them.
  - A file is rewritten only when its rendered content changed, so there's no churn.
  - Source files keep **no Drive revisions** (GitHub has the history).
  - Rendering is a pure function (snapshot → files) with snapshot tests.

## 5. Drive: generic read-only source folders (Drive never imports the plugin)

- **Migration:**
  - `drive_folder.source` and `drive_file.source` (nullable text, the source plugin id).
  - `drive_source_items (source, external_key, item_id, kind, content_sha)`, primary key
    `(source, external_key)`, for upserts.
- **Read-only rule:** goes in `allows()` **before the agent bypass**. For an item with a source:
  - `edit` is refused for everyone, the agent included.
  - `manage` covers sharing only (owner and admins). Rename, move, trash, delete, archive, the edit
    lock and new uploads into it are refused.
  - Message: "This comes from GitHub and is read-only here. Change it on GitHub."
  - `canEdit`/`canManage` go false, so the toolbar, drag and drop and row actions disappear
    without UI special cases.
- **`DriveSourcePort`** (wired in `modules/index.ts`, like the Calls ports):
  `ensureRoot(source, name)`, `upsertFolder(source, key, parentKey, name)`,
  `upsertText(source, key, parentKey, name, content)` (writes a blob only when the sha differs),
  `remove(source, keyPrefix)` and `list(source)`. It's the system writer and skips access checks.
  It's never a tool.
- **Visibility:** `ensureRoot` gives the source root a whole-company `view` grant (owner decision).
  Admins can narrow it with normal sharing.
- **Rail and UI:**
  - A **GitHub** section per registered source root, added to `sections.ts` through the port's
    list of roots, not a hardcoded GitHub entry.
  - A "GitHub · read-only" badge next to names (where "Shared" and "Archived" sit).
- **Exclusions:**
  - Source items are excluded from archive suggestions, like the Messages folders.
  - **Git-native G2** (Drive moving into the data repo) must exclude source items: they're derived
    and rebuilt by a sync, so they stay out of the data repo and out of backups.

## 6. The assistant knows

- **Prompt block:** a "Connected GitHub repos" block in the orchestrator prompt, supplied through a
  port, not an import.
  - One line per repo: full name, last push, open PRs, the first sentence of the summary, and the
    Drive folder id.
  - At most 20 repos, most recently pushed first.
  - The agent then reads the details with `drive.read`.
- **Tools (plugin `repos`):**
  - `repos.list` (read): connected repos, status, Drive folder ids.
  - `repos.sync_now` (mutate, `approvalRisk: internal`, activity "Synced `<repo>` from GitHub").
  - Nothing touches the token.
- **Event:** `repos.synced {repo, newCommits, prsOpened, prsMerged, prsClosed}` after a sync with
  changes. It appears in the activity feed, and recap can pick it up later.
- **AI summary:**
  - Only after a sync that found changes.
  - One call through the gateway (`src/lib/server/llm/`), with the new commits and PR changes plus
    the previous summary.
  - JSON schema `{summary, highlights: [{kind, text, ref}]}`, then parse/validate/persist only.
  - Uses the company's explicitly selected model (no implicit default). If none is set, the page
    shows "No model is selected for summaries". The pages still sync, and the summary block says it
    is missing.
  - Cost is attributed to the `repos` plugin.

## 7. The plugin

- **`modules/repos`** (id `repos`, name "GitHub repos"; the `github.*` namespace is the Website
  module's).
  - Its page is `/m/repos`, opened from Settings → Plugins and from the Drive rail's GitHub section
    ("Manage").
  - ~~No sidebar entry of its own.~~ Changed at the S3 merge: the shell gives every plugin a sidebar entry (`src/lib/plugins/routes.ts` + `buildShellNav`, pinned by `routes.spec.ts`), so **GitHub repos** has one, leading to `/m/repos`.
  - Can be deactivated like every plugin. Off means no sync, no prompt block, and its source root
    hidden from the rail (follows round-4 W7's "off is really off").
- **The Website module's GitHub connection is unchanged.** Deploys keep public / App / deploy-key
  repos, and **nothing is removed**. Deploying from a token-connected repo (`auth_kind: pat`) could
  come later and isn't in this plan.
- **Shared client:** `api.ts`, `jwt.ts` and `plain-errors.ts` move from `modules/website/github/`
  to `src/lib/server/github/`. The Website module imports them from there, with unchanged behaviour
  (its specs move along). Additions:
  - the GET-only token client
  - ETag/304
  - `Link` paging, with a hard cap that fails loudly
  - a request timeout and `retry-after`
  - the expiry header
  - plain errors worded for tokens; the App's wording stays for the App

## Slices

| Slice | What | Files | Runs |
|---|---|---|---|
| **S0** contract (main) | `DriveSourcePort` + `GitHubTokenClient` interfaces, the next two free migration numbers reserved (0132 drive sources and 0133 repos as of today), plugin manifest stub | port/type files only | first |
| **S1** shared client | lift + token additions, fixtures of real response shapes | `src/lib/server/github/**`, imports in `modules/website/github/*` | ∥ worktree |
| **S2** Drive source folders | 0132, read-only rule, `DriveSourcePort`, rail section, badge, archive exclusion | `modules/drive/**`, `src/lib/drive/**`, `src/lib/components/drive/**`, drive routes | ∥ worktree |
| **S3** repos plugin core | 0133, token page + sealing, repo picker, poller, renderer, fakes for GitHub + Drive port | `modules/repos/**`, `src/routes/(nucleus)/m/repos/**` | ∥ worktree |
| **S4** the assistant knows | prompt block, `repos.list`/`sync_now`, `repos.synced`, AI summary | orchestrator prompt port, `modules/repos/**` | after S2+S3 |
| **S5** proof on the box | real fine-grained token on one owner repo: paste → pick → folder appears → assistant answers "what's happening on branch X?" | e2e journey | last |

- **Tests first** throughout:
  - GitHub is faked at the transport, using response shapes recorded in S1.
  - Postgres specs cover the claim (two concurrent tickers), the upsert map, and the read-only rule
    (agent included).
  - A component test covers the badge and the hidden toolbar.
- **e2e:** the harness needs a fake GitHub selected explicitly (like `MAIL_TRANSPORT=fake`), never a
  default URL.

## Not in this plan, and why

- **Writing to GitHub** (webhooks, comments, statuses): the token is read-only by decision.
- **Classic tokens:** they grant write on every repo.
- **Webhooks for faster updates:** a read-only token can't create one. A webhook the owner adds by
  hand (with a secret per repo) could come later. 15-minute polling with ETags is the v1.
- **Code files:** the owner chose activity + docs.
- **Issues and CI status:** they need extra permissions (Issues: read, Commit statuses: read) and
  are easy to add later.
- **The GitHub App for this:** the owner prefers least privilege per repo, and the App has no
  `pull_requests:read`.
- **Indexing Drive into memory/pgvector:** Drive isn't indexed today. That's a Drive-wide question,
  not this plan's.

## To verify in S1 (before S3 depends on it)

- Whether `GET /user/repos` with a fine-grained token returns exactly the selected repos, org repos
  included when the org is the resource owner.
- An org can require approval for fine-grained tokens, or block them. Until approved, the token
  sees nothing, and the page has to say so when the list is empty.
- Which response headers carry the expiry and identify a classic token (`x-oauth-scopes`). The
  classic-token refusal must rest on what GitHub returns.
- Rate budget: 20 repos every 15 minutes with ETags should stay far under 5,000/h. Measure it.
