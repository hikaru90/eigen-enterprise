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
    github: GitHubStatusView
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
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import AppBuildForm from '$lib/components/app-build-form.svelte'
  import AppDeployProgress from '$lib/components/app-deploy-progress.svelte'
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { RadioGroup, RadioGroupItem } from '$lib/components/ui/radio-group'
  import * as Select from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { appHost, appSlug, freeName } from '../../../modules/website/apps/host'

  let { data }: { data: RepoConnectData } = $props()

  let step = $state<1 | 2 | 3>(1)
  let repoUrl = $state('')
  let inspected = $state<InspectedView | null>(null)
  let branch = $state('')
  let keyPending = $state<{
    repo: string
    keyId: string
    publicKey: string
    addKeyUrl: string
  } | null>(null)
  let keyBranches = $state<string[] | null>(null)
  let pickedDirect = $state(false)
  let connected = $state<{
    repo: string
    branch: string
    auth: 'public' | 'github_app' | 'deploy_key'
  } | null>(null)

  let stepError = $state<string | null>(null)
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

  function useConnected(row: RepoRowView) {
    inspected = null
    keyPending = null
    keyBranches = null
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
        stepError = problem
        return
      }
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
      if (
        typeof d.repo === 'string' &&
        typeof d.keyId === 'string' &&
        typeof d.publicKey === 'string' &&
        typeof d.addKeyUrl === 'string'
      ) {
        copied = false
        keyPending = {
          repo: d.repo,
          keyId: d.keyId,
          publicKey: d.publicKey,
          addKeyUrl: d.addKeyUrl,
        }
        keyBranches = null
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
      keyPending = null
      keyBranches = null
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
      pickedDirect = false
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

{#if !data.managed}
  <Alert class="mt-4" data-testid="not-managed">
    <AlertTitle>This server isn't managed by ee yet</AlertTitle>
    <AlertDescription>
      Apps can't be deployed from this page, because this Eigen Enterprise isn't running on a server
      set up with ee. Connecting the repo still works.
    </AlertDescription>
  </Alert>
{/if}

{#if step === 1}
  <section
    class="mt-6 flex flex-col gap-6"
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
          No repos connected yet — paste a link below, or connect one through the GitHub App.
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
      <h3 class="text-[13px] font-medium">Paste a GitHub link</h3>
      <form
        method="POST"
        action="?/inspect"
        use:enhance={inspectSubmit}
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
        <Button type="submit" data-testid="check-link">Check</Button>
      </form>
    </div>

    <div>
      <h3 class="text-[13px] font-medium">From GitHub</h3>
      {#if !data.github.installed}
        <p class="mt-1 text-sm text-muted-foreground">
          Want to pick from your GitHub repositories instead? Connect the GitHub App first —
          <a class="underline" href={resolve('/m/website/github')}>under GitHub</a>. Public links
          and deploy keys need no app.
        </p>
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
          <a class="mt-2 inline-block text-sm underline" rel="external" href={data.github.manageUrl}
            >Add more repos on GitHub</a
          >
        {/if}
      {/if}
    </div>
  </section>
{/if}

{#if step === 2 && inspected}
  <section
    class="mt-6 flex flex-col gap-4"
    aria-labelledby="step-access-heading"
    data-testid="step-access"
  >
    <div>
      <h2 id="step-access-heading" class="text-base font-semibold">2 · Access</h2>
      <p class="mt-0.5 text-sm text-muted-foreground">
        How this server may read {inspected.fullName}.
      </p>
    </div>

    {#if access === 'deploy_key'}
      <Badge data-testid="access-badge">Private repo — it needs a deploy key</Badge>
      {#if !keyPending}
        <form method="POST" action="?/deployKeyCreate" use:enhance={keyCreateSubmit}>
          <input type="hidden" name="repo" value={inspected.fullName} />
          <Button type="submit">Create a deploy key</Button>
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
    {:else}
      <Badge variant="secondary" data-testid="access-badge">
        {access === 'public'
          ? 'Public repo — no key needed'
          : 'Private repo — the GitHub App can read it'}
      </Badge>
      {@render branchPicker(inspected.fullName, '', '')}
    {/if}

    <Button type="button" variant="ghost" class="self-start" onclick={backFromAccess}>
      Choose a different repo
    </Button>
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

    <form method="POST" action="?/deploy" use:enhance={deploySubmit} class="flex flex-col gap-4">
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
          This repo isn't connected through the GitHub App, so it's deployed by hand (Deploy now);
          there is no push-to-deploy.
        </p>
      {/if}
      <AppBuildForm
        nodeVersions={data.catalog?.runtimes.node ?? []}
        target={buildTarget}
        onsuggested={(s) => (kind = s.kind === 'service' ? 'backend' : 'web')}
      />
      <div>
        <Button type="submit" disabled={!data.managed || deploying}>
          {deploying ? 'Starting…' : 'Deploy'}
        </Button>
      </div>
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
