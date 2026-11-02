<script lang="ts">
  import { deployModeText } from './deploy-mode'
  import type { ActionData, PageData } from './$types'
  import { onMount } from 'svelte'
  import { enhance } from '$app/forms'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import AppBuildForm from '$lib/components/app-build-form.svelte'
  import AppDeployProgress from '$lib/components/app-deploy-progress.svelte'
  import AppStatusDot from '$lib/components/app-status-dot.svelte'
  import * as Alert from '$lib/components/ui/alert'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { Badge } from '$lib/components/ui/badge'
  import * as Breadcrumb from '$lib/components/ui/breadcrumb'
  import { Button, buttonVariants } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import * as Table from '$lib/components/ui/table'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  type Busy =
    'domainSet' | 'domainRemove' | 'env' | 'secretSet' | 'remove' | 'mailEnable' | 'mailDisable'
  let busy = $state<Busy | null>(null)
  let starting = $state(false)
  let panel = $state<ReturnType<typeof AppDeployProgress> | null>(null)
  let howtoCopied = $state(false)
  let settingsOpen = $state(false)
  onMount(() => {
    const openLinkedSettings = () => {
      if (window.location.hash === '#settings') settingsOpen = true
    }
    openLinkedSettings()
    window.addEventListener('hashchange', openLinkedSettings)
    return () => window.removeEventListener('hashchange', openLinkedSettings)
  })

  /** What goes into the app repo's AGENTS.md: the pinned how-to and the standing rules. */
  const agentsSnippet = $derived(
    [
      '## Sending email',
      'This app runs on eigenEnterprise, which provides email. Read and follow',
      `${data.howtoUrl} — it is the only source of truth for sending email from this app.`,
      'The platform injects EE_API_URL and EE_API_KEY at runtime. Never add API keys,',
      'SMTP settings, or mail libraries (nodemailer, Resend, SendGrid, …) to this repo.',
      'If sending email is not enabled, tell the owner; do not work around it.',
    ].join('\n'),
  )

  async function copyAgentsSnippet() {
    await navigator.clipboard.writeText(agentsSnippet)
    howtoCopied = true
    setTimeout(() => (howtoCopied = false), 2000)
  }

  /** Deploy in the background; the panel polls its progress (started here, from the click). */
  async function deployNow() {
    if (!panel) return
    starting = true
    try {
      await panel.redeploy()
    } finally {
      starting = false
    }
  }

  const track = (what: Busy) => () => {
    busy = what
    return async ({ update }: { update: () => Promise<void> }) => {
      await update()
      busy = null
    }
  }

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

  const kindLabel = $derived(data.app.kind === 'web' ? 'Web app' : 'Back-end service')
  const siteUrl = $derived(data.app.domains.length > 0 ? `https://${data.app.domains[0]}` : null)
</script>

<svelte:head><title>{data.app.name} · Apps · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-3">
    <Breadcrumb.Root>
      <Breadcrumb.List>
        <Breadcrumb.Item>
          <Breadcrumb.Link href={resolve('/m/website')}>Website</Breadcrumb.Link>
        </Breadcrumb.Item>
        <Breadcrumb.Separator />
        <Breadcrumb.Item>
          <Breadcrumb.Page>{data.app.name}</Breadcrumb.Page>
        </Breadcrumb.Item>
      </Breadcrumb.List>
    </Breadcrumb.Root>
    <div class="flex min-w-0 flex-wrap items-center gap-3">
      <h1 class="text-xl font-semibold tracking-tight">{data.app.name}</h1>
      <Badge variant="secondary">{kindLabel}</Badge>
      <AppStatusDot status={data.app.status} />
    </div>
    <p class="text-sm break-words text-foreground/60">
      {data.app.repo} · {data.app.branch}{data.app.shortSha ? `@${data.app.shortSha}` : ''} · last deploy
      {when(data.app.lastDeployedAt)}
    </p>
    {#if siteUrl}
      <a
        href={siteUrl}
        class="text-sm break-all underline"
        rel="external noopener noreferrer"
        target="_blank">{siteUrl}</a
      >
    {/if}
    {#if data.app.lastError}
      <Alert.Root variant="destructive">
        <Alert.Title>The last deploy failed</Alert.Title>
        <Alert.Description>{data.app.lastError}</Alert.Description>
      </Alert.Root>
    {/if}
    {#if form && 'error' in form && form.error}
      <p class="text-sm text-red-600" role="alert">{form.error}</p>
    {:else if form && 'message' in form}
      <p class="text-sm text-foreground/70" role="status">{form.message}</p>
    {/if}
  </header>

  <nav class="mt-6 flex gap-4 text-sm" aria-label="App sections">
    <a class="underline underline-offset-4" href="#overview">Overview &amp; deployments</a>
    <a class="underline underline-offset-4" href="#settings" onclick={() => (settingsOpen = true)}
      >App settings</a
    >
  </nav>

  <Card.Root class="mt-6" id="overview">
    <Card.Header>
      <Card.Title>Deploy</Card.Title>
      <Card.Description>
        <span data-testid="deploy-mode">{deployModeText(data.app)}</span>
        Build contract: {data.app.contractSource === 'repo'
          ? "the repo's ee.json."
          : 'the saved build settings below.'}
        Redeploy fetches the current branch head and deploys it with exactly that config — no AI, nothing
        to fill out. If nothing changed since the last deploy, the live app stays as it is.
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      {#if !data.managed}
        <p class="text-sm text-muted-foreground">
          Deployment server not connected.
          <a class="underline" href={resolve('/m/website/settings')}>View server settings</a> to resolve
          the connection.
        </p>
      {/if}
      <div>
        <Button
          type="button"
          onclick={deployNow}
          disabled={!data.managed || busy !== null || starting}
        >
          {starting ? 'Starting…' : 'Redeploy'}
        </Button>
      </div>
      <AppDeployProgress
        bind:this={panel}
        name={data.app.name}
        initial={data.lastDeploy?.state === 'failed' ? data.lastDeploy : null}
        onlive={() => invalidateAll()}
      />
    </Card.Content>
  </Card.Root>

  <Card.Root class="mt-6">
    <Card.Header>
      <Card.Title>Deploy history</Card.Title>
    </Card.Header>
    <Card.Content>
      {#if data.app.history.length === 0}
        <p class="text-sm text-muted-foreground">No deploys yet.</p>
      {:else}
        <ul class="flex flex-col gap-1" data-testid="deploy-history">
          {#each data.app.history.slice(0, 30) as e, i (i)}
            <li class="text-xs break-words text-foreground/70">
              <span class="text-foreground/45">{when(e.time)}</span> · {e.message}
            </li>
          {/each}
        </ul>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root class="mt-6">
    <Card.Header>
      <Card.Title>Recent logs</Card.Title>
    </Card.Header>
    <Card.Content>
      {#if data.logsError}
        <p class="text-sm text-muted-foreground">{data.logsError}</p>
      {:else}
        <pre
          data-testid="app-logs"
          class="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{data.logs.join(
            '\n',
          )}</pre>
      {/if}
    </Card.Content>
  </Card.Root>

  <details id="settings" bind:open={settingsOpen} class="mt-8 rounded-lg border border-border p-5">
    <summary class="cursor-pointer text-base font-semibold">App settings</summary>
    <p class="mt-2 text-sm text-muted-foreground">
      Domains, build configuration, environment, secrets and app services.
    </p>
    <a class="mt-3 inline-block text-sm underline" href={resolve('/m/website/settings')}
      >Website settings: all domains &amp; server status</a
    >
    <Card.Root class="mt-6">
      <Card.Header>
        <Card.Title>Domains &amp; routing</Card.Title>
        <Card.Description>
          Each domain routes visitors to this app. Point its A or AAAA DNS records at the server;
          Caddy manages HTTPS certificates automatically once DNS and ports 80/443 are reachable.
        </Card.Description>
      </Card.Header>
      <Card.Content class="flex flex-col gap-4">
        <p class="text-xs text-muted-foreground">
          Certificate issuance status is not reported.
          <a class="underline" href={resolve('/m/website/settings#https')}
            >HTTPS &amp; certificate settings</a
          >.
        </p>
        {#if data.app.domains.length === 0}
          <p class="text-sm text-muted-foreground">No address yet.</p>
        {:else}
          <Table.Root>
            <Table.Body>
              {#each data.app.domains as d (d)}
                <Table.Row>
                  <Table.Cell class="break-all font-mono text-xs">{d}</Table.Cell>
                  <Table.Cell class="w-full max-w-xs">
                    <form
                      method="POST"
                      action="?/domainSet"
                      use:enhance={track('domainSet')}
                      class="flex items-center gap-2"
                    >
                      <input type="hidden" name="replace" value={d} />
                      <Input
                        name="host"
                        required
                        placeholder="new.example.com"
                        aria-label={`Replace ${d}`}
                        class="h-8 min-w-0 flex-1 font-mono text-xs"
                      />
                      <Button type="submit" variant="outline" size="sm" disabled={busy !== null}
                        >Save</Button
                      >
                    </form>
                  </Table.Cell>
                  <Table.Cell class="w-24">
                    <AlertDialog.Root>
                      <AlertDialog.Trigger class={buttonVariants({ variant: 'ghost', size: 'sm' })}
                        >Remove</AlertDialog.Trigger
                      >
                      <AlertDialog.Content>
                        <AlertDialog.Header>
                          <AlertDialog.Title>Remove {d}?</AlertDialog.Title>
                          <AlertDialog.Description>
                            It stops serving this app. DNS can keep pointing here; nothing else
                            changes.
                          </AlertDialog.Description>
                        </AlertDialog.Header>
                        <form
                          method="POST"
                          action="?/domainRemove"
                          use:enhance={track('domainRemove')}
                        >
                          <input type="hidden" name="host" value={d} />
                          <AlertDialog.Footer>
                            <AlertDialog.Cancel disabled={busy !== null}>Keep it</AlertDialog.Cancel
                            >
                            <AlertDialog.Action
                              type="submit"
                              variant="destructive"
                              disabled={busy !== null}
                            >
                              {busy === 'domainRemove' ? 'Removing…' : 'Remove address'}
                            </AlertDialog.Action>
                          </AlertDialog.Footer>
                        </form>
                      </AlertDialog.Content>
                    </AlertDialog.Root>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}
        <form
          method="POST"
          action="?/domainSet"
          use:enhance={track('domainSet')}
          class="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-end"
        >
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label for="add-domain">Add a domain</Label>
            <Input
              id="add-domain"
              name="host"
              required
              placeholder="shop.example.com"
              class="font-mono text-xs"
            />
          </div>
          <Button type="submit" variant="outline" disabled={busy !== null}>Add domain</Button>
        </form>
      </Card.Content>
    </Card.Root>

    {#if data.app.contractSource === 'form'}
      <Card.Root class="mt-6">
        <Card.Header>
          <Card.Title>Build settings</Card.Title>
          <Card.Description>
            How this app is built and started; the repo has no ee.json, so these saved settings are
            the contract. Redeploy uses them; edit and deploy here to change them.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <form
            method="POST"
            action="?/deploy"
            class="flex flex-col gap-3"
            use:enhance={() => {
              starting = true
              return async ({ result, update }) => {
                await update({ reset: false })
                starting = false
                // Runs in the background: follow it from here (no $effect).
                const started = result.type === 'success' ? result.data : null
                if (started && typeof started.jobId === 'string') void panel?.follow(started.jobId)
              }
            }}
          >
            <AppBuildForm
              nodeVersions={data.nodeVersions}
              initial={data.contractFields ?? undefined}
              target={{ name: data.app.name }}
            />
            <div>
              <Button type="submit" variant="outline" disabled={busy !== null || starting}>
                Deploy with these settings
              </Button>
            </div>
          </form>
        </Card.Content>
      </Card.Root>
    {/if}

    <Card.Root class="mt-6">
      <Card.Header>
        <Card.Title>Environment variables &amp; secrets</Card.Title>
        <Card.Description>
          API keys, passwords and settings the app reads from its environment. Stored encrypted on
          this server, given to the app while it builds and while it runs, and never shown again.
          Changing one rebuilds the app.
        </Card.Description>
      </Card.Header>
      <Card.Content class="flex flex-col gap-3">
        {#if data.secretNames.length === 0}
          <p class="text-sm text-muted-foreground">None yet.</p>
        {:else}
          <ul class="flex flex-col gap-1" data-testid="env-names">
            {#each data.secretNames as key (key)}
              <li class="flex items-center gap-2 font-mono text-xs">
                {key}
                {#if data.app.env.includes(key)}
                  <Badge variant="outline">sealed</Badge>
                {:else}
                  <Badge variant="destructive">needed by the repo, not set</Badge>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        <form
          method="POST"
          action="?/env"
          use:enhance={track('env')}
          class="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row"
          autocomplete="off"
        >
          <Input
            name="key"
            required
            placeholder="NAME"
            aria-label="Variable name"
            class="font-mono text-xs"
          />
          <Input
            name="value"
            type="password"
            required
            placeholder="value (stored sealed, never shown again)"
            aria-label="Variable value"
            class="min-w-0 flex-1 font-mono text-xs"
          />
          <Button type="submit" variant="outline" disabled={busy !== null}>
            {busy === 'env' ? 'Saving…' : 'Set'}
          </Button>
        </form>
      </Card.Content>
    </Card.Root>

    <Card.Root class="mt-6">
      <Card.Header>
        <Card.Title>Email</Card.Title>
        <Card.Description>
          Let this app send email through this server. It gets a key that can only send mail (60 a
          minute, every send recorded under <code class="font-mono text-xs"
            >app:{data.app.name}</code
          >), sealed into the app as <code class="font-mono text-xs">EE_API_KEY</code>. Turning it
          off revokes the key at once.
        </Card.Description>
      </Card.Header>
      <Card.Content class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-3">
          {#if data.app.mail.enabled}
            <Badge>on</Badge>
            <span class="text-sm">This app can send email.</span>
            <form method="POST" action="?/mailDisable" use:enhance={track('mailDisable')}>
              <Button type="submit" variant="outline" disabled={busy !== null}>
                {busy === 'mailDisable' ? 'Turning off…' : 'Turn off'}
              </Button>
            </form>
            <form method="POST" action="?/mailEnable" use:enhance={track('mailEnable')}>
              <Button type="submit" variant="ghost" disabled={busy !== null}>
                {busy === 'mailEnable' ? 'Rotating…' : 'Rotate key'}
              </Button>
            </form>
          {:else}
            <Badge variant="outline">off</Badge>
            <span class="text-sm text-muted-foreground">This app cannot send email.</span>
            <form method="POST" action="?/mailEnable" use:enhance={track('mailEnable')}>
              <Button type="submit" disabled={busy !== null}>
                {busy === 'mailEnable' ? 'Turning on…' : 'Allow this app to send email'}
              </Button>
            </form>
          {/if}
        </div>
        {#if form && (form.action === 'mailEnable' || form.action === 'mailDisable')}
          {#if 'error' in form}
            <p class="text-sm text-destructive">{form.error}</p>
          {:else}
            <p class="text-sm">{form.message}</p>
          {/if}
        {/if}
        <div class="flex flex-col gap-2 border-t border-border pt-4">
          <p class="text-sm">
            For whoever builds the app (or their coding agent): the how-to with a ready
            <code class="font-mono text-xs">sendMail</code> function is at
            <a
              class="underline"
              href={resolve('/docs/send-mail.md')}
              target="_blank"
              rel="noopener noreferrer">{data.howtoUrl}</a
            >. Put this in the app repo's <code class="font-mono text-xs">AGENTS.md</code>:
          </p>
          <pre
            class="overflow-x-auto rounded-[4px] bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{agentsSnippet}</pre>
          <div>
            <Button type="button" variant="outline" size="sm" onclick={copyAgentsSnippet}>
              {howtoCopied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      </Card.Content>
    </Card.Root>

    <Card.Root class="mt-10 border-red-500/40">
      <Card.Header>
        <Card.Title class="text-red-600">Danger zone</Card.Title>
        <Card.Description>
          Removes the app and its addresses from this server. The repo stays connected.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <AlertDialog.Root>
          <AlertDialog.Trigger class={buttonVariants({ variant: 'destructive' })}>
            Remove this app…
          </AlertDialog.Trigger>
          <AlertDialog.Content>
            <AlertDialog.Header>
              <AlertDialog.Title>Remove {data.app.name}?</AlertDialog.Title>
              <AlertDialog.Description>
                It stops serving and its addresses are freed. This cannot be undone; deploy it again
                to bring it back.
              </AlertDialog.Description>
            </AlertDialog.Header>
            <form method="POST" action="?/remove" use:enhance={track('remove')}>
              <AlertDialog.Footer>
                <AlertDialog.Cancel disabled={busy !== null}>Keep it</AlertDialog.Cancel>
                <AlertDialog.Action type="submit" variant="destructive" disabled={busy !== null}>
                  {busy === 'remove' ? 'Removing…' : 'Remove app'}
                </AlertDialog.Action>
              </AlertDialog.Footer>
            </form>
          </AlertDialog.Content>
        </AlertDialog.Root>
      </Card.Content>
    </Card.Root>
  </details>
</div>
