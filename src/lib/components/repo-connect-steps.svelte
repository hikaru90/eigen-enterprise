<script lang="ts" module>
  export type GitHubStatusView = {
    connected: boolean
    installed: boolean
    appSlug: string | null
    manageUrl: string | null
  }
  export type RepoRowView = {
    fullName: string
    branch: string
    htmlUrl: string
    visibility: 'public' | 'private'
    authKind: 'public' | 'github_app' | 'deploy_key'
    /** A service already deploys this repo + branch (so it may not be disconnected here). */
    used: boolean
    usedBy: string | null
    /** A free app name derived from the repo. */
    suggestedName: string
  }
  export type AvailableRepoView = {
    fullName: string
    visibility: 'public' | 'private'
    defaultBranch: string
  }
  export type InspectedView = {
    fullName: string
    visibility: 'public' | 'private'
    defaultBranch: string
    branches: string[]
    installationId: number | null
  }
  export type RepoConnectData = {
    ownerId: string
    github: GitHubStatusView
    /** The App manifest to connect GitHub right here (null when already connected). */
    githubManifest: { json: string; state: string } | null
    repos: RepoRowView[]
    available: AvailableRepoView[] | null
    availableError: string | null
    /** App names already in use, so a suggested name can be free. */
    takenNames: string[]
    catalog: { runtimes: { node: string[] } } | null
    appsError: string | null
    managed: boolean
    consoleHost: string | null
    managedReason: string | null
    /** Repository selected on the overview, or a link to inspect. */
    repoHint?: string | null
    branchHint?: string | null
  }
</script>

<script lang="ts">
  /**
   * Adding an app from a repo, in three explicit steps (decision D-W4):
   * repository → access (a deploy key only when the repo is private) → the
   * app itself, deployed in the background. The current step is plain $state
   * moved by click/submit handlers — never an $effect — and every form posts
   * to the page's actions through enhance, so the owner's click is their
   * approval and errors arrive as plain sentences.
   */
  import { onMount } from 'svelte'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import AppBuildForm from '$lib/components/app-build-form.svelte'
  import AppDeployProgress from '$lib/components/app-deploy-progress.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { RadioGroup, RadioGroupItem } from '$lib/components/ui/radio-group'
  import * as Select from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { appHost, appSlug, freeName } from '../../../modules/website/apps/host'
  import { parseGitHubRepo } from '../../../modules/website/github/repo-url'
  import GitHubAppConnect from './github-app-connect.svelte'

  let {
    data,
    /** The action's own error when the form submitted before hydration (a native POST) — shown like any step error. */
    nativeError = null,
    nativeResult = null,
  }: {
    data: RepoConnectData
    nativeError?: string | null
    nativeResult?: Record<string, unknown> | null
  } = $props()

  // Seed native POST results during SSR too, so the generated public key is
  // visible even before hydration (and is not lost if JavaScript is delayed).
  const initialPending = () =>
    nativeResult?.action === 'deploy_key' ? pendingMetadata(nativeResult) : null
  const nativeBranches = (): string[] | null =>
    initialPending() &&
    !nativeError &&
    Array.isArray(nativeResult?.branches) &&
    nativeResult.branches.every((v) => typeof v === 'string')
      ? (nativeResult.branches as string[])
      : null
  const nativeBranch = () =>
    nativeBranches()?.includes(String(nativeResult?.branch)) ? String(nativeResult?.branch) : ''

  let step = $state<1 | 2 | 3>(initialPending() ? 2 : 1)
  let repoUrl = $state('')
  let visibility = $state<'public' | 'private'>('public')
  let inspected = $state<InspectedView | null>(null)
  let branch = $state(nativeBranch())
  /** A pasted repo GitHub won't show without auth: private, so the key flow starts here. */
  let privateRepo = $state<string | null>(null)
  type PendingKey = { repo: string; keyId: string; publicKey: string; addKeyUrl: string }
  let keyPending = $state<PendingKey | null>(initialPending())
  let keyBranches = $state<string[] | null>(nativeBranches())
  let pickedDirect = $state(false)
  let connected = $state<{
    repo: string
    branch: string
    auth: 'public' | 'github_app' | 'deploy_key'
  } | null>(null)

  // Seeded once from a native-submit form result; then owned by the handlers.
  // svelte-ignore state_referenced_locally
  let stepError = $state<string | null>(nativeError ?? null)
  let storageError = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let noticeLink = $state<{ href: string; label: string } | null>(null)

  let name = $state('')
  let kind = $state<'web' | 'backend'>('web')
  let host = $state('')
  let hostEdited = $state(false)
  let autoDeploy = $state(false)
  let deploying = $state(false)
  let liveName = $state<string | null>(null)
  let copied = $state(false)
  let panel = $state<ReturnType<typeof AppDeployProgress> | null>(null)

  // Public by GitHub's own record, private through the installed App, or a deploy key.
  const access = $derived.by(() => {
    if (!inspected) return null
    if (inspected.visibility === 'public') return 'public' as const
    return inspected.installationId !== null ? ('github_app' as const) : ('deploy_key' as const)
  })
  const branches = $derived(keyBranches ?? inspected?.branches ?? [])
  const buildTarget = $derived.by(() =>
    connected && name ? { name, repo: connected.repo, branch: connected.branch } : null,
  )

  type ActionPayload = { error?: unknown; message?: unknown; link?: unknown } & Record<
    string,
    unknown
  >
  /** The form answer behind a success/failure result; null after a redirect or a crash. */
  function actionData(result: { type?: string; data?: unknown }): ActionPayload | null {
    return result.type === 'success' || result.type === 'failure'
      ? (result.data as ActionPayload)
      : null
  }
  const errorOf = (d: ActionPayload): string | null =>
    typeof d.error === 'string' ? d.error : null
  const linkOf = (d: ActionPayload): { href: string; label: string } | null => {
    if (!d.link || typeof d.link !== 'object') return null
    const l = d.link as { href?: unknown; label?: unknown }
    return typeof l.href === 'string' && typeof l.label === 'string'
      ? { href: l.href, label: l.label }
      : null
  }

  /** A free app name derived from the repo (the same rule the server's suggested names follow). */
  function suggestName(fullName: string): string {
    return freeName(new Set(data.takenNames), appSlug(fullName.split('/')[1] ?? fullName))
  }

  function derivedHost(forName: string): string {
    return (data.consoleHost ? appHost(data.consoleHost, forName) : null) ?? ''
  }

  // This is public setup metadata, scoped to the signed-in owner and this tab.
  // The private key is held exclusively by ee and never reaches the browser.
  const pendingStorageKey = () => `ee:github:pending-deploy-key:${data.ownerId}`

  function pendingMetadata(value: unknown): PendingKey | null {
    if (!value || typeof value !== 'object') return null
    const v = value as Record<string, unknown>
    if (
      typeof v.repo !== 'string' ||
      typeof v.keyId !== 'string' ||
      typeof v.publicKey !== 'string'
    )
      return null
    const parsed = parseGitHubRepo(v.repo)
    if (!parsed.ok || !/^dk_[a-f0-9]{24}$/.test(v.keyId) || !v.publicKey.startsWith('ssh-ed25519 '))
      return null
    const repo = `${parsed.owner}/${parsed.repo}`
    return {
      repo,
      keyId: v.keyId,
      publicKey: v.publicKey,
      addKeyUrl: `https://github.com/${repo}/settings/keys/new`,
    }
  }

  function savePending(key: PendingKey) {
    try {
      sessionStorage.setItem(
        pendingStorageKey(),
        JSON.stringify({ repo: key.repo, keyId: key.keyId, publicKey: key.publicKey }),
      )
    } catch {
      storageError =
        'Your browser could not save this deploy-key setup. Keep this page open until you connect the repository or cancel and delete the key.'
    }
  }

  function clearPending() {
    try {
      sessionStorage.removeItem(pendingStorageKey())
    } catch {
      storageError =
        'Your browser could not clear the saved deploy-key setup. The server action succeeded; the saved setup may still appear after a refresh.'
    }
  }

  function resumePending(key: PendingKey, resumed: boolean) {
    keyPending = key
    keyBranches = null
    visibility = 'private'
    repoUrl = key.repo
    step = 2
    if (resumed)
      notice = `Resumed unfinished deploy-key setup for ${key.repo}. Check access to continue, or cancel and delete the key.`
  }

  onMount(() => {
    // A native POST can complete before hydration. Recover its public key
    // before reading the previous setup so a successful server action is visible.
    if (nativeResult?.action === 'deploy_key') {
      const key = pendingMetadata(nativeResult)
      if (key) {
        resumePending(key, false)
        keyBranches = nativeBranches()
        branch = nativeBranch()
        savePending(key)
        return
      }
    }
    if (nativeResult?.action === 'deploy_key_cancel' && nativeResult.ok === true) {
      clearPending()
      notice = typeof nativeResult.message === 'string' ? nativeResult.message : null
      noticeLink = linkOf(nativeResult)
      return
    }
    if (nativeResult?.action === 'connect' && nativeResult.ok === true) {
      if (nativeResult.keyId) clearPending()
      const parsed =
        typeof nativeResult.repo === 'string' ? parseGitHubRepo(nativeResult.repo) : null
      const fullName = parsed?.ok ? `${parsed.owner}/${parsed.repo}` : null
      const row = data.repos.find(
        (r) =>
          r.fullName.toLowerCase() === fullName?.toLowerCase() && r.branch === nativeResult?.branch,
      )
      if (row) {
        useConnected(row)
        return
      }
    }
    try {
      const saved = sessionStorage.getItem(pendingStorageKey())
      if (saved) {
        const key = pendingMetadata(JSON.parse(saved))
        if (!key) throw new Error('Invalid saved deploy-key metadata')
        resumePending(key, true)
        return
      }
    } catch {
      storageError =
        'The saved deploy-key setup could not be read. Keep the original setup page open to finish connecting or delete the unused key.'
    }
    if (!data.repoHint) return
    const requestedBranch = data.branchHint
    const row = data.repos.find(
      (r) =>
        r.fullName.toLowerCase() === data.repoHint?.toLowerCase() &&
        (requestedBranch == null || r.branch === requestedBranch),
    )
    if (row) useConnected(row)
    else {
      repoUrl = data.repoHint
      if (requestedBranch != null) {
        notice = `${data.repoHint} (${requestedBranch}) is not connected. Choose a connected branch below, or connect the repository and select that branch.`
      }
    }
  })

  function useConnected(row: RepoRowView) {
    inspected = null
    keyPending = null
    keyBranches = null
    privateRepo = null
    stepError = null
    notice = null
    noticeLink = null
    pickedDirect = true
    connected = { repo: row.fullName, branch: row.branch, auth: row.authKind }
    beginApp(row.suggestedName)
  }

  function beginApp(suggested: string) {
    name = suggested
    kind = 'web'
    autoDeploy = false
    hostEdited = false
    host = derivedHost(suggested)
    liveName = null
    step = 3
  }

  function backFromAccess() {
    step = 1
    inspected = null
    keyPending = null
    keyBranches = null
    stepError = null
  }

  function backFromApp() {
    step = pickedDirect ? 1 : 2
    stepError = null
  }

  function onNameInput(value: string) {
    name = value
    if (!hostEdited) host = derivedHost(value)
  }

  function onHostInput(value: string) {
    host = value
    hostEdited = true
  }

  async function copyPublicKey(key: string) {
    try {
      await navigator.clipboard.writeText(key)
      copied = true
    } catch {
      // Clipboard denied: the key stays selectable in the field, so nothing is lost.
      copied = false
    }
  }

  const inspectSubmit = () => {
    stepError = null
    return async ({
      result,
      update,
    }: {
      result: unknown
      update: (opts?: { reset?: boolean }) => Promise<void>
    }) => {
      await update({ reset: false })
      const d = actionData(result as { type?: string; data?: unknown })
      if (!d) return
      const problem = errorOf(d)
      if (problem) {
        // A private repo is invisible to a plain read — GitHub answers as if it
        // wasn't there. That is not a dead end: the deploy-key flow starts here.
        privateRepo = d.keyPath === true && typeof d.repo === 'string' ? d.repo : null
        if (privateRepo) keyPending = null
        stepError = problem
        return
      }
      privateRepo = null
      const view = d.inspected as InspectedView | undefined
      if (!view) return
      inspected = view
      branch = typeof d.branch === 'string' ? d.branch : view.defaultBranch
      keyPending = null
      keyBranches = null
      step = 2
    }
  }

  const keyCreateSubmit = () => {
    stepError = null
    return async ({
      result,
      update,
    }: {
      result: unknown
      update: (opts?: { reset?: boolean }) => Promise<void>
    }) => {
      await update({ reset: false })
      const d = actionData(result as { type?: string; data?: unknown })
      if (!d) return
      const problem = errorOf(d)
      if (problem) {
        stepError = problem
        return
      }
      const key = pendingMetadata(d)
      if (key) {
        copied = false
        resumePending(key, false)
        savePending(key)
      } else {
        stepError =
          'The server did not return a valid deploy-key setup. No key was shown; check the server before creating another.'
      }
    }
  }

  const keyCheckSubmit = () => {
    stepError = null
    return async ({
      result,
      update,
    }: {
      result: unknown
      update: (opts?: { reset?: boolean }) => Promise<void>
    }) => {
      await update({ reset: false })
      const d = actionData(result as { type?: string; data?: unknown })
      if (!d) return
      const problem = errorOf(d)
      if (problem) {
        stepError = problem
        return
      }
      if (Array.isArray(d.branches) && typeof d.branch === 'string') {
        keyBranches = d.branches as string[]
        branch = d.branch
      }
    }
  }

  const keyCancelSubmit = () => {
    stepError = null
    return async ({
      result,
      update,
    }: {
      result: unknown
      update: (opts?: { reset?: boolean }) => Promise<void>
    }) => {
      await update({ reset: false })
      const d = actionData(result as { type?: string; data?: unknown })
      if (!d) return
      const problem = errorOf(d)
      if (problem) {
        stepError = problem
        return
      }
      clearPending()
      keyPending = null
      keyBranches = null
      privateRepo = null
      if (!inspected) step = 1
      copied = false
      notice = typeof d.message === 'string' ? d.message : null
      noticeLink = linkOf(d)
    }
  }

  const disconnectSubmit = () => {
    stepError = null
    return async ({
      result,
      update,
    }: {
      result: unknown
      update: (opts?: { reset?: boolean }) => Promise<void>
    }) => {
      await update()
      const d = actionData(result as { type?: string; data?: unknown })
      if (!d) return
      const problem = errorOf(d)
      if (problem) {
        stepError = problem
        return
      }
      notice = typeof d.message === 'string' ? d.message : null
      noticeLink = linkOf(d)
    }
  }

  const connectSubmit = () => {
    stepError = null
    // Frozen at submit time: the callback must not depend on later state changes.
    const repo = keyPending?.repo ?? inspected?.fullName ?? ''
    const pickedBranch = branch
    const byKey = keyPending !== null
    const auth = byKey
      ? ('deploy_key' as const)
      : access === 'github_app'
        ? ('github_app' as const)
        : ('public' as const)
    return async ({
      result,
      update,
    }: {
      result: unknown
      update: (opts?: { reset?: boolean }) => Promise<void>
    }) => {
      await update({ reset: false })
      const d = actionData(result as { type?: string; data?: unknown })
      if (!d) return
      const problem = errorOf(d)
      if (problem) {
        stepError = problem
        return
      }
      connected = { repo, branch: pickedBranch, auth }
      notice = null
      noticeLink = null
      // Once connected the key belongs to the saved repository. Do not offer
      // deletion as though it were still an unused setup key.
      if (byKey) {
        clearPending()
        keyPending = null
        keyBranches = null
      }
      pickedDirect = byKey
      beginApp(suggestName(repo))
    }
  }

  const deploySubmit = () => {
    deploying = true
    stepError = null
    liveName = null
    return async ({
      result,
      update,
    }: {
      result: unknown
      update: (opts?: { reset?: boolean }) => Promise<void>
    }) => {
      await update({ reset: false })
      deploying = false
      const d = actionData(result as { type?: string; data?: unknown })
      if (!d) return
      if (typeof d.jobId === 'string' && typeof d.name === 'string') {
        // The deploy runs in the background: follow it from here (no $effect).
        void panel?.follow(d.jobId, d.name)
      } else if (typeof d.error === 'string') {
        stepError = d.error
      }
    }
  }

  const authLabel = (r: RepoRowView) =>
    r.authKind === 'deploy_key' ? 'private, deploy key' : r.visibility
</script>

{#snippet deployKeyCard(repoName: string)}
  {#if !keyPending}
    {#if !data.managed}
      <p class="text-sm text-muted-foreground">
        A deployment server is needed to generate and store a private repository’s deploy key.
        Connect this stack to a server installed with ee, then return here.
      </p>
    {/if}
    <form method="POST" action="?/deployKeyCreate" use:enhance={keyCreateSubmit}>
      <input type="hidden" name="repo" value={repoName} />
      <Button type="submit" disabled={!data.managed}>Create a deploy key</Button>
    </form>
  {:else}
    <div class="rounded-md border p-4">
      <Label for="public-key">Public key</Label>
      <textarea
        id="public-key"
        readonly
        rows="2"
        class="mt-1 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs break-all"
        >{keyPending.publicKey}</textarea
      >
      <Button
        type="button"
        size="sm"
        variant="outline"
        class="mt-2"
        onclick={() => copyPublicKey(keyPending?.publicKey ?? '')}
      >
        {copied ? 'Copied' : 'Copy key'}
      </Button>
      <ol class="mt-4 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          <a
            class="underline"
            rel="external noopener noreferrer"
            target="_blank"
            href={keyPending.addKeyUrl}>Open the repo's deploy keys on GitHub</a
          > (Settings → Deploy keys → Add deploy key).
        </li>
        <li>Give it any title, and paste the key into “Key”.</li>
        <li>Leave “Allow write access” off. This server only needs to read.</li>
        <li>Click “Add key”, then come back and click “Check access”.</li>
      </ol>
      <div class="mt-4 flex flex-wrap gap-2">
        <form method="POST" action="?/deployKeyCheck" use:enhance={keyCheckSubmit}>
          <input type="hidden" name="repo" value={keyPending.repo} />
          <input type="hidden" name="keyId" value={keyPending.keyId} />
          <input type="hidden" name="publicKey" value={keyPending.publicKey} />
          <Button type="submit">Check access</Button>
        </form>
        <form method="POST" action="?/deployKeyCancel" use:enhance={keyCancelSubmit}>
          <input type="hidden" name="repo" value={keyPending.repo} />
          <input type="hidden" name="keyId" value={keyPending.keyId} />
          <input type="hidden" name="publicKey" value={keyPending.publicKey} />
          <Button type="submit" variant="ghost">Cancel and delete the key</Button>
        </form>
      </div>
      {#if keyBranches}
        <p class="mt-4 text-xs text-muted-foreground">GitHub accepted the key.</p>
        {@render branchPicker(keyPending.repo, keyPending.keyId, keyPending.publicKey)}
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet branchPicker(repoValue: string, keyIdValue: string, publicKeyValue: string)}
  <form
    method="POST"
    action="?/connect"
    use:enhance={connectSubmit}
    class="flex flex-wrap items-end gap-2"
  >
    <input type="hidden" name="repo" value={repoValue} />
    <input type="hidden" name="keyId" value={keyIdValue} />
    <input type="hidden" name="publicKey" value={publicKeyValue} />
    <input type="hidden" name="branch" value={branch} />
    <div class="flex flex-col gap-1">
      <span class="text-sm">Branch</span>
      <Select.Root
        type="single"
        value={branch}
        onValueChange={(v) => {
          if (typeof v === 'string' && v !== '') branch = v
        }}
      >
        <Select.Trigger class="min-w-48" aria-label="Branch">
          {branch || 'Pick a branch'}
        </Select.Trigger>
        <Select.Content>
          {#each branches as b (b)}
            <Select.Item value={b}>
              {b}{inspected && b === inspected.defaultBranch ? ' (default)' : ''}
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <Button type="submit">Continue</Button>
  </form>
{/snippet}

{#if data.appsError}
  <p class="text-sm text-red-600" role="alert">{data.appsError}</p>
{/if}

<ol class="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Steps" data-testid="step-header">
  {#each ['Repository', 'Access', 'App'] as label, i (label)}
    <li
      class={step === i + 1 ? 'font-medium text-foreground' : 'text-muted-foreground'}
      aria-current={step === i + 1 ? 'step' : undefined}
    >
      {i + 1} · {label}
    </li>
  {/each}
</ol>

{#if storageError}
  <p class="mt-3 text-sm text-red-600" role="alert">{storageError}</p>
{/if}
{#if stepError}
  <p class="mt-3 text-sm text-red-600" role="alert" data-testid="step-error">{stepError}</p>
{/if}
{#if notice}
  <p class="mt-3 text-sm" role="status" data-testid="step-notice">
    {notice}
    {#if noticeLink}
      <a class="underline" rel="external noopener noreferrer" target="_blank" href={noticeLink.href}
        >{noticeLink.label}</a
      >
    {/if}
  </p>
{/if}

{#if step === 1}
  <section
    class="mt-6 flex flex-col gap-6 rounded-xl border bg-card p-5 sm:p-6"
    aria-labelledby="step-repo-heading"
    data-testid="step-repository"
  >
    <div>
      <h2 id="step-repo-heading" class="text-base font-semibold">1 · Repository</h2>
      <p class="mt-0.5 text-sm text-muted-foreground">Where the app's code comes from.</p>
    </div>

    <div>
      <h3 class="text-[13px] font-medium">Already connected</h3>
      {#if data.repos.length === 0}
        <p class="mt-1 text-sm text-muted-foreground">
          Connect a public or private GitHub repository below.
        </p>
      {:else}
        <ul class="mt-2 divide-y rounded-md border">
          {#each data.repos as r (`${r.fullName}#${r.branch}`)}
            <li
              class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
              data-testid={`connected-${r.fullName}`}
            >
              <span class="min-w-0 flex-1">
                <a
                  class="block truncate text-sm underline-offset-2 hover:underline"
                  rel="external"
                  href={r.htmlUrl}>{r.fullName}</a
                >
                <span class="block text-xs text-muted-foreground">{r.branch}</span>
              </span>
              <Badge variant="secondary">{authLabel(r)}</Badge>
              {#if r.used}
                <Badge variant="outline">in use by {r.usedBy}</Badge>
              {/if}
              <Button
                type="button"
                size="sm"
                data-testid={`use-${r.fullName}`}
                onclick={() => useConnected(r)}>Use</Button
              >
              {#if !r.used}
                <form method="POST" action="?/disconnect" use:enhance={disconnectSubmit}>
                  <input type="hidden" name="repo" value={r.fullName} />
                  <input type="hidden" name="branch" value={r.branch} />
                  <Button
                    type="submit"
                    size="sm"
                    variant="ghost"
                    aria-label="Disconnect {r.fullName} ({r.branch})">Disconnect</Button
                  >
                </form>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div>
      <h3 class="text-sm font-medium">Connect a GitHub repository</h3>
      <RadioGroup class="mt-3 flex flex-wrap gap-5" bind:value={visibility}>
        <div class="flex items-center gap-2">
          <RadioGroupItem value="public" id="visibility-public" />
          <Label for="visibility-public">Public repository</Label>
        </div>
        <div class="flex items-center gap-2">
          <RadioGroupItem value="private" id="visibility-private" />
          <Label for="visibility-private">Private repository</Label>
        </div>
      </RadioGroup>
      <p class="mt-2 text-xs text-muted-foreground">
        {visibility === 'public'
          ? 'Connect by URL. No account access or key needed.'
          : 'Generate a read-only deploy key, add it to this repository on GitHub, then verify access.'}
      </p>
      <form
        method="POST"
        action={visibility === 'private' ? '?/deployKeyCreate' : '?/inspect'}
        use:enhance={() => (visibility === 'private' ? keyCreateSubmit() : inspectSubmit())}
        class="mt-2 flex flex-wrap items-end gap-2"
      >
        <Label class="min-w-64 flex-1" for="repo-link">
          Repository link
          <Input
            id="repo-link"
            name="repo"
            bind:value={repoUrl}
            placeholder="https://github.com/owner/repo"
            autocomplete="off"
            required
            class="mt-1"
          />
        </Label>
        <Button
          type="submit"
          data-testid="check-link"
          disabled={visibility === 'private' && !data.managed}
          >{visibility === 'private' ? 'Generate deploy key' : 'Find repository'}</Button
        >
      </form>
      {#if visibility === 'private' && !data.managed}
        <p class="mt-3 text-sm text-muted-foreground">
          A deployment server is needed to generate and store a private repository’s deploy key.
          Connect this stack to a server installed with ee, then return here.
        </p>
      {/if}
      {#if privateRepo}
        <div class="mt-4 flex flex-col gap-3 rounded-md border p-4" data-testid="private-key-path">
          <div>
            <Badge>Private repo — it needs a deploy key</Badge>
            <p class="mt-2 text-sm text-muted-foreground">
              GitHub won't show {privateRepo} without a key. Create one, add it to the repo on GitHub,
              and this server can read it — read-only, nothing else.
            </p>
          </div>
          {@render deployKeyCard(privateRepo)}
        </div>
      {/if}
    </div>

    <details class="rounded-lg border p-4">
      <summary class="cursor-pointer text-sm font-medium"
        >Advanced: connect through a GitHub App</summary
      >
      <div class="mt-3">
        {#if !data.github.installed}
          <p class="mt-1 text-sm text-muted-foreground">
            Want to pick from your GitHub repositories instead? Connect the GitHub App here. Public
            links and deploy keys need no app.
          </p>
          <div class="mt-3">
            <GitHubAppConnect github={data.github} manifest={data.githubManifest} />
          </div>
        {:else if data.availableError}
          <p class="mt-1 text-sm text-red-600" role="alert">{data.availableError}</p>
        {:else if data.available && data.available.length === 0}
          <p class="mt-1 text-sm text-muted-foreground">The app cannot see any repositories yet.</p>
        {:else if data.available}
          <ul class="mt-2 divide-y rounded-md border">
            {#each data.available as r (r.fullName)}
              <li class="flex min-w-0 items-center gap-3 px-3 py-2.5">
                <span class="min-w-0 flex-1 truncate text-sm">{r.fullName}</span>
                <Badge variant="secondary">{r.visibility}</Badge>
                <form method="POST" action="?/inspect" use:enhance={inspectSubmit}>
                  <input type="hidden" name="repo" value={r.fullName} />
                  <Button type="submit" size="sm" variant="outline">Choose</Button>
                </form>
              </li>
            {/each}
          </ul>
          {#if data.github.manageUrl}
            <a
              class="mt-2 inline-block text-sm underline"
              rel="external"
              href={data.github.manageUrl}>Add more repos on GitHub</a
            >
          {/if}
        {/if}
      </div>
    </details>
  </section>
{/if}

{#if step === 2 && (inspected || keyPending)}
  <section
    class="mt-6 flex flex-col gap-4"
    aria-labelledby="step-access-heading"
    data-testid="step-access"
  >
    <div>
      <h2 id="step-access-heading" class="text-base font-semibold">2 · Access</h2>
      <p class="mt-0.5 text-sm text-muted-foreground">
        Allow read-only access to {keyPending?.repo ?? inspected?.fullName}.
      </p>
    </div>

    {#if keyPending || access === 'deploy_key'}
      <Badge data-testid="access-badge">Private repo — it needs a deploy key</Badge>
      {@render deployKeyCard(keyPending?.repo ?? inspected?.fullName ?? '')}
    {:else}
      <Badge variant="secondary" data-testid="access-badge">
        {access === 'public'
          ? 'Public repo — no key needed'
          : 'Private repo — the GitHub App can read it'}
      </Badge>
      {@render branchPicker(inspected?.fullName ?? '', '', '')}
    {/if}

    <Button
      type="button"
      variant="ghost"
      class="self-start"
      disabled={keyPending !== null}
      onclick={backFromAccess}
    >
      Choose a different repo
    </Button>
    {#if keyPending}
      <p class="text-xs text-muted-foreground">
        To change repositories, cancel and delete the unused key first.
      </p>
    {/if}
  </section>
{/if}

{#if step === 3 && connected}
  <section
    class="mt-6 flex flex-col gap-5"
    aria-labelledby="step-app-heading"
    data-testid="step-app"
  >
    <div>
      <h2 id="step-app-heading" class="text-base font-semibold">3 · App</h2>
      <p class="mt-0.5 text-sm text-muted-foreground">
        {connected.repo} ({connected.branch}) — name it, say what it is, deploy.
      </p>
    </div>

    {#if !data.managed}
      <div class="rounded-lg border bg-muted/30 p-4" data-testid="not-managed">
        <h3 class="font-medium">Connect a deployment server</h3>
        <p class="mt-1 text-sm text-muted-foreground">
          {connected.repo} is connected. To build and run this app, this stack needs a server installed
          with ee. Your repository is saved; you can return to deploy it when the server is ready.
        </p>
        <a class="mt-3 inline-block text-sm underline" href={resolve('/m/website')}
          >Back to apps</a
        >
      </div>
    {/if}
    <form method="POST" action="?/deploy" use:enhance={deploySubmit} class="flex flex-col gap-4">
      <fieldset disabled={!data.managed} class="flex flex-col gap-4 disabled:opacity-60">
        <input type="hidden" name="repo" value={connected.repo} />
        <input type="hidden" name="branch" value={connected.branch} />
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex flex-col gap-1">
            <Label for="app-name">App name</Label>
            <Input
              id="app-name"
              name="name"
              value={name}
              oninput={(e) => onNameInput(e.currentTarget.value)}
              autocomplete="off"
              required
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="app-host">Domain {kind === 'web' ? '' : '(optional)'}</Label>
            <Input
              id="app-host"
              name="host"
              value={host}
              oninput={(e) => onHostInput(e.currentTarget.value)}
              placeholder={data.consoleHost
                ? 'chosen from this server’s address'
                : 'for example app.example.com'}
              required={kind === 'web'}
              autocomplete="off"
            />
            <p class="text-xs text-muted-foreground">
              {kind === 'web'
                ? 'Where the app will be served. Leave what is suggested unless you own the domain.'
                : 'A back-end service has no public address.'}
            </p>
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-sm">Kind</span>
          <RadioGroup
            class="flex flex-wrap gap-x-6 gap-y-2"
            value={kind}
            onValueChange={(v) => {
              if (v === 'web' || v === 'backend') kind = v
            }}
          >
            <div class="flex items-center gap-2">
              <RadioGroupItem value="web" id="kind-web" />
              <Label for="kind-web">Web app (gets an address)</Label>
            </div>
            <div class="flex items-center gap-2">
              <RadioGroupItem value="backend" id="kind-backend" />
              <Label for="kind-backend">Back-end service (no public address)</Label>
            </div>
          </RadioGroup>
          <input type="hidden" name="kind" value={kind} />
        </div>
        {#if connected.auth === 'github_app'}
          <div class="flex items-center gap-2">
            <Switch id="auto-deploy" bind:checked={autoDeploy} />
            <Label for="auto-deploy">Deploy automatically on every push to this branch</Label>
            <input type="hidden" name="autoDeploy" value={autoDeploy ? 'on' : ''} />
          </div>
        {:else}
          <p class="text-xs text-muted-foreground">
            This repo isn't connected through the GitHub App, so it's deployed by hand (Redeploy);
            there is no push-to-deploy.
          </p>
        {/if}
        <details class="rounded-lg border p-4">
          <summary class="cursor-pointer text-sm font-medium">Build settings</summary>
          <p class="my-3 text-xs text-muted-foreground">
            Use the repository’s ee.json, or configure the build commands here.
          </p>
          <AppBuildForm
            nodeVersions={data.catalog?.runtimes.node ?? []}
            target={buildTarget}
            onsuggested={(s) => (kind = s.kind === 'service' ? 'backend' : 'web')}
          />
        </details>
        <div>
          <Button type="submit" disabled={!data.managed || deploying}>
            {deploying ? 'Starting…' : 'Deploy'}
          </Button>
        </div>
      </fieldset>
    </form>

    <AppDeployProgress bind:this={panel} {name} onlive={() => (liveName = name)} />
    {#if liveName}
      <a
        class="text-sm font-medium underline underline-offset-2"
        href={resolve(`/m/website/apps/${liveName}`)}
        data-testid="open-app"
      >
        Open {liveName}
      </a>
    {/if}

    <Button type="button" variant="ghost" class="self-start" onclick={backFromApp}>
      {pickedDirect ? 'Choose a different repo' : 'Back to access'}
    </Button>
  </section>
{/if}
