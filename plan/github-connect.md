# Connect a GitHub repo — design note

Status: built 2026-10-20 (step "connect"); deploying a connected repo is the next step.
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

- **Deploy keys / SSH**: not now. The App covers private repos with repo listing and push events. Deploy keys would mean storing an SSH private key for each repo, plus SSH clone support in ee's mirror. If an owner can't install an App, a later step could add read-only deploy keys, using ee's mirror with an SSH URL.
- **Several GitHub sources, GitHub Enterprise, GitLab/Gitea/Bitbucket**: one company, one GitHub App on github.com. Single tenant keeps it simple.
- **PR preview deployments and self-hosted runners**: these need write permissions (pull_requests, administration). We stay read-only.
- **Docker / docker-compose build packs**: D16 says native catalog runtimes only. ee builds from `ee.json`.
- **Silent fallbacks** (Coolify tries `master` after `main` fails, and on rate limit it assumes the branch exists): we always show the real branch list and fail loudly with a plain message.

## How it fits here

- Kernel tools in the website module: `website.github_list_repos`, `website.github_available_repos`, `website.github_inspect_repo` (read), `website.github_connect_repo` (mutate, approvalRisk internal), `website.github_disconnect_repo` (mutate, approvalRisk destructive). Both mutating tools are on the approval-gated list, so the agent can connect from chat under the owner's approval mode. In the dashboard, the owner's click counts as their approval (it's recorded as one).
- UI: `/m/website/github`, linked from the Website module's settings ("GitHub connection"). Errors are shown as plain sentences. GitHub's raw API errors stay in the server log and the error `cause`.
- Connecting doesn't touch the server (D11). **Next step, deploy**: the existing `github.app_create` / ee path (`ee/src/sources.ts` fetches into a local mirror, using a freshly minted installation token for that single fetch) should take a connected repo as input: repo id → full name and clone URL, branch → ref, installation id → token (none for public repos). It should then create the ee app and link it. The webhook should match pushes by repo id plus branch, rather than by full name.
