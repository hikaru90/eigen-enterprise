# Connect a GitHub repo — design note

Status: built 2026-10-20 (step "connect"), deploy keys added the same day (default for private repos); deploying a connected repo is the next step.
Scope: Website module (plan/phase-platform.md), code in `modules/website/github`.
Studied: Coolify (github.com/coollabsio/coolify), design only. No code was copied and no PHP is used. Everything here is our own TypeScript.

## What Coolify does

- **Public repos** need no credentials. The user pastes a URL. Coolify takes owner/repo from the path (and a branch, if the link has `/tree/<branch>`), then asks the unauthenticated GitHub API whether that branch exists. When the anonymous rate limit runs out, it tells the user when the limit resets. The repo is later cloned over plain https.
- **Private repos** go through a **GitHub App**, one per "source":
  - The App is registered with GitHub's *manifest flow*: a form is POSTed to `github.com/settings/apps/new` (or the org variant). The form carries a JSON manifest with the name, the webhook URL, redirect and setup URLs, permissions (contents/metadata read, plus more for PR previews) and events (`push`, optionally `pull_request`). It also carries a `state` value.
  - GitHub redirects back with a one-time code. Coolify exchanges it for the App id, the private key, the webhook secret and the client secret, and stores them.
  - The user installs the App on chosen repos. GitHub calls the setup URL with an `installation_id`, and Coolify stores it on the source.
  - For every call, Coolify signs a short JWT with the App key, exchanges it for a ~1h **installation token**, then pages through `/installation/repositories` and `/repos/{o}/{r}/branches` 100 at a time.
  - Each application stores the GitHub **numeric repository id** together with the branch. Because that id doesn't change when a repo is renamed, webhook lookups still work after a rename.
  - **Webhooks** (push-to-deploy): the signature is HMAC-SHA256 over the raw body with the App's webhook secret. The App is identified by the hook's target-id header plus the payload's installation id. Apps are then matched by repo id and branch. Installation events keep the stored installation in sync.
- **Deploy keys** are the alternative: the user registers an SSH key pair, adds the public key to the repo as a read-only deploy key, and Coolify clones over SSH. One key covers one repo, and there's no repo listing and no push events.

## What we adopt

- **Public repos by URL, no auth.** We parse the URL structurally (host plus path segments; `/tree/<branch>` gives a branch hint). We validate through `GET /repos/{o}/{r}` and the branch list, and we report a used-up rate limit with its reset time, in plain words.
- **One GitHub App per company via the manifest flow.** This already existed under Settings → Hosting. It has least privilege: `contents:read` and `metadata:read`, push events only, and a private App. The callback checks `state` against an httpOnly cookie. Credentials are sealed with `TENANT_MASTER_KEY` (AES-GCM, AAD-bound). The setup URL checks the installation with the App's own JWT before recording it.
- **Installation tokens minted on demand, never stored.** The new table `github_connected_repos` (migration 0093) holds the repo id, full name, branch, visibility, clone URL, and the installation id for private repos. It holds no token.
- **Key on GitHub's numeric repo id plus branch**, like Coolify, so renames don't break anything and a webhook can match by id.
- **Paginate** both the installation repos and the branches (100 per page, with a hard cap that fails loudly).
- **"Add more repos on GitHub"** links to the App's installation page (`<app html_url>/installations/new`). GitHub shows "Configure" there for an existing installation.

## What we don't adopt, and why

- ~~Deploy keys / SSH: not now.~~ Reversed 2026-10-20 by the owner: see "Private repos: deploy keys" below.
- **Several GitHub sources, GitHub Enterprise, GitLab/Gitea/Bitbucket**: one company, one GitHub App on github.com. Single tenant keeps it simple.
- **PR preview deployments and self-hosted runners**: these need write permissions (pull_requests, administration). We stay read-only.
- **Docker / docker-compose build packs**: D16 says native catalog runtimes only. ee builds from `ee.json`.
- **Silent fallbacks** (Coolify tries `master` after `main` fails, and on rate limit it assumes the branch exists): we always show the real branch list and fail loudly with a plain message.

## How it fits here

- Kernel tools in the website module: `website.github_list_repos`, `website.github_available_repos`, `website.github_inspect_repo` (read), `website.github_connect_repo` (mutate, approvalRisk internal), `website.github_disconnect_repo` (mutate, approvalRisk destructive). Both mutating tools are on the approval-gated list, so the agent can connect from chat under the owner's approval mode. In the dashboard, the owner's click counts as their approval (it's recorded as one).
- UI: `/m/website/github`, linked from the Website module's settings ("GitHub connection"). Errors are shown as plain sentences. GitHub's raw API errors stay in the server log and the error `cause`.
- Connecting doesn't touch the server (D11). **Next step, deploy**: the existing `github.app_create` / ee path (`ee/src/sources.ts` fetches into a local mirror, using a freshly minted installation token for that single fetch) should take a connected repo as input: repo id → full name and clone URL, branch → ref, installation id → token (none for public repos). It should then create the ee app and link it. The webhook should match pushes by repo id plus branch, rather than by full name.

## Private repos: deploy keys (owner's decision, 2026-10-20)

The owner does not want to connect their whole GitHub account through an App by default. Public repos stay "by link, no auth". Private repos default to a **read-only deploy key per repo**. The GitHub App code stays, collapsed under "Advanced: connect through a GitHub App" on `/m/website/github`.

- **Flow** (`/m/website/github`, "Connect a private repo with a deploy key"): the owner enters the repo (`https://github.com/owner/repo` or `git@github.com:owner/repo.git`, parsed structurally in `repo-url.ts`). The server asks ee for a fresh ed25519 pair and shows the PUBLIC key with a copy button and the steps (open `https://github.com/<o>/<r>/settings/keys/new`, paste, leave "Allow write access" off, Add key). "Check access" runs a read-only `git ls-remote --heads` over SSH through ee and lists the branches; the owner picks one and connects. A refusal shows "GitHub didn't accept the key yet — check it was added to this repo (Settings → Deploy keys)."; ssh's output only goes to the server log. "Cancel and delete the key" deletes an unused key.
- **ee owns the key.** ee control API (unix socket `/run/ee/control/ee.sock`):
  - `POST /v1/deploy-keys {repo, author}` → `{keyId, publicKey}`. `ssh-keygen -t ed25519 -N ''` into a 0700 temp dir under `/var/lib/ee/ssh-tmp`, which is removed right after. The pair is stored only in the sealed secret store (AES-256-GCM under the host key), scope `_deploy_keys`, id `dk_<24 hex>`. That scope is not settable through `POST /v1/secrets` (all `_` scopes are internal).
  - `POST /v1/deploy-keys/:id/check {repo}` → `{ok: true, branches}` or `{ok: false, error: 'not_accepted', detail}`. The key must belong to that repo.
  - `DELETE /v1/deploy-keys/:id {author}` → `{ok: true}`, or 404 for an unknown key.
  - `POST /v1/sources/fetch` also takes `{url: 'git@github.com:o/r.git', deployKeyId}`, so a deploy uses the same key.
  - Every SSH use writes the key to a 0600 file plus GitHub's published host keys (from `api.github.com/meta`, pinned in `ee/src/deploy-keys.ts`) to a known_hosts file in a fresh 0700 dir, runs git with `GIT_SSH_COMMAND="ssh -i … -F /dev/null -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=… -o GlobalKnownHostsFile=/dev/null"`, then deletes the dir. It never uses accept-new and never turns the check off. If GitHub rotates its host keys, the pinned list in `deploy-keys.ts` has to be updated.
  - `ee bootstrap` now installs `openssh-client` (apt runs with `--no-install-recommends`, so git alone doesn't bring ssh).
- **No ee, no deploy keys.** Under plain `npm run dev` the socket is missing. The tools then fail loud with "Private repos need the server's deploy agent…", with no fallback store.
- **D11.** Creating and deleting a key changes the server's secret store, so `website.github_deploy_key_create`, `website.github_deploy_key_delete`, and disconnecting a deploy-key repo are human-only (`requireHuman`). On the page they are the owner's own click. The check is read-only, and the agent may run it.
- **Persistence**: migration `0094_github_deploy_keys`. `auth_kind` is `public | github_app | deploy_key`, `deploy_key_id` holds ee's id, and no key material is stored. `github_app` is a third kind for the existing App rows, which carry the installation id. `repo_id` became nullable, because a deploy-key repo is never read through the API. Rows are unique by `(repo_id, branch)` and by `(lower(full_name), branch)`, and a CHECK constraint enforces the shape of each kind. Disconnecting a deploy-key repo deletes the key in ee first, then the row, and tells the owner they can remove it on GitHub as well, with a link to `…/settings/keys`.
- **Tools**: `website.github_connect_repo` takes `auth: {kind: 'deploy_key', keyId}`. New tools: `website.github_deploy_key_create` (mutate, internal, "Created a deploy key for o/r", admin only and human-only), `website.github_deploy_key_check` (read, admin and agent), and `website.github_deploy_key_delete` (mutate, destructive, "Deleted the deploy key for o/r", human-only, refused while a connected repo uses the key). The create and delete tools are not on the approval-gated list, because D11 already limits them to a human's own action.
- **Not built yet**: a deploy-key repo shows no last commit (it has no API access) until deploy. Deploy-key repos get no push webhooks, so deploys are manual or use polling later.

## Deploy (built 2026-10-20)

The "next step" above is done: Website → Apps (`/m/website/apps`, `modules/website/apps`) deploys a connected repo + branch through ee's mirror with the right auth per kind. It matches webhook pushes by repo id + branch. Deploy-key repos have no push events and are deployed by hand. See plan/progress.md 2026-10-20 (8).
