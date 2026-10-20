<script lang="ts" module>
  export type GitHubConnectStatusView = {
    connected: boolean
    installed: boolean
    appSlug: string | null
    manageUrl: string | null
  }
  export type ConnectedRepoRow = {
    fullName: string
    branch: string
    htmlUrl: string
    visibility: 'public' | 'private'
    lastCommit: { sha: string; message: string; date: string | null } | null
    lastCommitError: string | null
  }
  export type AvailableRepoRow = {
    fullName: string
    visibility: 'public' | 'private'
    defaultBranch: string
  }
  export type InspectedRepoView = {
    fullName: string
    visibility: 'public' | 'private'
    defaultBranch: string
    branches: string[]
  }
  export type GitHubConnectForm =
    | {
        action: 'inspect'
        repo: string
        inspected: InspectedRepoView
        branch: string
        error?: undefined
      }
    | { action: 'inspect' | 'connect' | 'disconnect'; repo: string; error: string }
    | { action: 'connect' | 'disconnect'; ok: true; message: string; error?: undefined }
    | null
</script>

<script lang="ts">
  /**
   * Connect GitHub and GitHub repositories (plan/github-connect.md). Plain
   * forms posting to the page's actions; every message shown is already
   * plain words from the server.
   */
  let {
    github,
    repos,
    available,
    availableError,
    manifest,
    form,
  }: {
    github: GitHubConnectStatusView
    repos: ConnectedRepoRow[]
    available: AvailableRepoRow[] | null
    availableError: string | null
    manifest: { json: string; state: string } | null
    form: GitHubConnectForm
  } = $props()

  let githubOrg = $state('')
  const manifestAction = $derived(
    manifest
      ? githubOrg.trim()
        ? `https://github.com/organizations/${encodeURIComponent(githubOrg.trim())}/settings/apps/new?state=${manifest.state}`
        : `https://github.com/settings/apps/new?state=${manifest.state}`
      : '',
  )
  const picked = $derived(form?.action === 'inspect' && 'inspected' in form ? form : null)
  const errorFor = (action: string) =>
    form && form.action === action && form.error ? form.error : null

  const inputCls =
    'h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60'
  const btnCls =
    'inline-flex h-9 shrink-0 items-center rounded-md bg-foreground px-3 text-[13px] font-medium text-background outline-none hover:bg-foreground/85 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2'
  const quietBtnCls =
    'inline-flex h-8 shrink-0 items-center rounded-md border border-border px-3 text-[13px] font-medium outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60'

  function shortDate(iso: string | null): string {
    return iso ? new Date(iso).toISOString().slice(0, 10) : 'unknown date'
  }
</script>

{#if form && 'ok' in form && form.ok}
  <p class="mt-6 rounded-md border border-border px-4 py-3 text-sm" role="status">{form.message}</p>
{/if}

<section class="mt-8" aria-labelledby="gh-connect-heading" data-testid="github-connect-app">
  <h2 id="gh-connect-heading" class="text-[13px] font-medium">1. Connect GitHub</h2>
  {#if !github.connected && manifest}
    <ol class="mt-2 list-decimal space-y-1 pl-5 text-sm text-foreground/70">
      <li>Click “Connect GitHub”. GitHub opens and shows a ready-made app for your company.</li>
      <li>Click “Create GitHub App” there. It can only read code, and only of repos you pick.</li>
      <li>
        GitHub then asks where to install it: pick your account or organization and the repos.
      </li>
      <li>You come back here and your repos are listed below.</li>
    </ol>
    <form method="POST" action={manifestAction} class="mt-4 flex flex-wrap items-end gap-2">
      <input type="hidden" name="manifest" value={manifest.json} />
      <label class="min-w-48 flex-1 text-xs text-foreground/60">
        GitHub organization (leave empty for your personal account)
        <input bind:value={githubOrg} name="org" class="{inputCls} mt-1" autocomplete="off" />
      </label>
      <button class={btnCls} data-testid="github-connect-start">Connect GitHub</button>
    </form>
    <p class="mt-2 text-xs text-foreground/55">
      Public repos can be connected below without this step.
    </p>
  {:else if github.connected && !github.installed}
    <p class="mt-2 text-sm text-foreground/70">
      The app <strong>{github.appSlug}</strong> exists but is not installed yet.
      <a class="underline" rel="external" href={github.manageUrl}>Install it on your repositories</a
      >.
    </p>
  {:else}
    <p class="mt-2 text-sm text-foreground/70" data-testid="github-connected">
      Connected through the GitHub App <strong>{github.appSlug}</strong>.
    </p>
  {/if}
</section>

<section class="mt-10" aria-labelledby="gh-public-heading">
  <h2 id="gh-public-heading" class="text-[13px] font-medium">2. Connect a public repo by link</h2>
  <form method="POST" action="?/inspect" class="mt-2 flex flex-wrap items-end gap-2">
    <label class="min-w-64 flex-1 text-xs text-foreground/60">
      Repository link
      <input
        name="repo"
        class="{inputCls} mt-1"
        placeholder="https://github.com/owner/repo"
        value={form?.action === 'inspect' ? form.repo : ''}
        autocomplete="off"
        required
      />
    </label>
    <button class={btnCls}>Check</button>
  </form>
  {#if errorFor('inspect')}
    <p class="mt-2 text-sm text-red-700 dark:text-red-400" role="alert">{errorFor('inspect')}</p>
  {/if}
</section>

{#if github.installed}
  <section class="mt-10" aria-labelledby="gh-private-heading" data-testid="github-available">
    <h2 id="gh-private-heading" class="text-[13px] font-medium">
      3. Or pick a repo the app can see
    </h2>
    {#if availableError}
      <p class="mt-2 text-sm text-red-700 dark:text-red-400" role="alert">{availableError}</p>
    {:else if available && available.length === 0}
      <p class="mt-2 text-sm text-foreground/60">The app cannot see any repositories yet.</p>
    {:else if available}
      <ul class="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
        {#each available as r (r.fullName)}
          <li class="flex min-w-0 items-center gap-3 px-4 py-2.5">
            <span class="min-w-0 flex-1 truncate text-sm">{r.fullName}</span>
            <span class="shrink-0 text-xs text-foreground/55">{r.visibility}</span>
            <form method="POST" action="?/inspect">
              <input type="hidden" name="repo" value={r.fullName} />
              <button class={quietBtnCls}>Choose</button>
            </form>
          </li>
        {/each}
      </ul>
    {/if}
    {#if github.manageUrl}
      <a class="mt-2 inline-block text-sm underline" rel="external" href={github.manageUrl}
        >Add more repos on GitHub</a
      >
    {/if}
  </section>
{/if}

{#if picked}
  <section
    class="mt-8 rounded-lg border border-border px-4 py-4"
    aria-labelledby="gh-branch-heading"
    data-testid="github-branch-picker"
  >
    <h2 id="gh-branch-heading" class="text-sm font-medium">
      {picked.inspected.fullName}
      <span class="font-normal text-foreground/55">({picked.inspected.visibility})</span>
    </h2>
    <form method="POST" action="?/connect" class="mt-3 flex flex-wrap items-end gap-2">
      <input type="hidden" name="repo" value={picked.inspected.fullName} />
      <label class="min-w-48 flex-1 text-xs text-foreground/60">
        Branch
        <select name="branch" class="{inputCls} mt-1" value={picked.branch}>
          {#each picked.inspected.branches as b (b)}
            <option value={b}>{b}{b === picked.inspected.defaultBranch ? ' (default)' : ''}</option>
          {/each}
        </select>
      </label>
      <button class={btnCls}>Connect</button>
    </form>
  </section>
{/if}
{#if errorFor('connect')}
  <p class="mt-2 text-sm text-red-700 dark:text-red-400" role="alert">{errorFor('connect')}</p>
{/if}

<section class="mt-10" aria-labelledby="gh-repos-heading" data-testid="github-connected-repos">
  <h2 id="gh-repos-heading" class="text-[13px] font-medium">Connected repos</h2>
  {#if repos.length === 0}
    <p class="mt-2 text-sm text-foreground/55">No repos connected yet.</p>
  {:else}
    <ul class="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
      {#each repos as r (`${r.fullName}#${r.branch}`)}
        <li class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
          <span class="min-w-0 flex-1">
            <a
              class="block truncate text-sm font-medium underline-offset-2 hover:underline"
              rel="external"
              href={r.htmlUrl}>{r.fullName}</a
            >
            <span class="block truncate text-xs text-foreground/55">
              {r.branch} · {r.visibility} ·
              {#if r.lastCommit}
                {r.lastCommit.sha.slice(0, 7)} “{r.lastCommit.message}” ({shortDate(
                  r.lastCommit.date,
                )})
              {:else}
                {r.lastCommitError}
              {/if}
            </span>
          </span>
          <form method="POST" action="?/disconnect">
            <input type="hidden" name="repo" value={r.fullName} />
            <input type="hidden" name="branch" value={r.branch} />
            <button class={quietBtnCls} aria-label="Disconnect {r.fullName} ({r.branch})"
              >Disconnect</button
            >
          </form>
        </li>
      {/each}
    </ul>
  {/if}
  {#if errorFor('disconnect')}
    <p class="mt-2 text-sm text-red-700 dark:text-red-400" role="alert">{errorFor('disconnect')}</p>
  {/if}
  <p class="mt-3 text-xs text-foreground/55">
    Deploying a connected repo comes next; connecting does not change this server.
  </p>
</section>
