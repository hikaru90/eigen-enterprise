<script lang="ts">
  import { shownErrorOf } from '$lib/errors/agent-report'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import type { PageProps } from './$types'
  import { onMount, untrack } from 'svelte'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import type { UpgradeJob, UpgradeStep } from '$lib/server/ee/client'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: PageProps = $props()

  const info = $derived(data.updates)

  /** eigenenterprise-0.5.16-14424746613a-linux-arm64.tar.gz → { version, build } */
  const parts = (name: string) => {
    const m = /^eigenenterprise-(\d+\.\d+\.\d+)-([0-9a-f]{12})/.exec(name)
    return m ? { version: m[1]!, build: m[2]! } : { version: name, build: '' }
  }

  // The update as last heard from ee — seeded from the load, then from polling.
  let job = $state<UpgradeJob | null>(untrack(() => (data.updates.onBox ? data.updates.job : null)))
  /** live: ee answers; offline: ee or the app is restarting (reconnecting); signed-out: back, but this sign-in is not. */
  let conn = $state<'live' | 'offline' | 'signed-out'>('live')
  let busy = $state(false)
  /** This page watched the update run (a success seen on load is just a line, not the whole panel). */
  let watched = $state(untrack(() => job?.status === 'running'))
  const error = $derived(shownErrorOf(form))

  const latest = $derived(info.onBox && info.latest?.ok ? info.latest.release : null)
  const offered = $derived(
    latest !== null &&
      (latest.state === 'newer' || latest.state === 'rebuild') &&
      job?.status !== 'running' &&
      !(job?.status === 'succeeded' && job.release === latest.name),
  )

  const STEPS: Array<{ label: string; steps: UpgradeStep[] }> = [
    { label: 'Check the release and its signature', steps: ['handover', 'verifying'] },
    {
      label: 'Take a safety copy (the database and the server’s own settings)',
      steps: ['safety-copy'],
    },
    {
      label:
        'Install the new release and start it (migrations run; the old one stays live until it is healthy)',
      steps: ['installing'],
    },
  ]
  const current = $derived(
    job === null
      ? -1
      : job.step === 'done'
        ? STEPS.length
        : STEPS.findIndex((s) => s.steps.includes(job!.step)),
  )

  let polling = false
  let stopped = false
  async function poll() {
    if (polling) return
    polling = true
    try {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 2000))
        let res: Response
        try {
          res = await fetch(resolve('/(nucleus)/settings/updates/job'), {
            redirect: 'manual',
            headers: { accept: 'application/json' },
          })
        } catch {
          conn = 'offline'
          continue
        }
        if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) {
          conn = 'signed-out'
          break
        }
        // ee or the app is restarting: Caddy's 502, our 503 — keep trying.
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
          conn = 'offline'
          continue
        }
        const body = (await res.json()) as { job: UpgradeJob | null }
        conn = 'live'
        job = body.job
        if (!job || job.status !== 'running') break
      }
    } finally {
      polling = false
    }
  }

  onMount(() => {
    if (job?.status === 'running') void poll()
    return () => {
      stopped = true
    }
  })

  const primary =
    'h-9 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
  const secondary =
    'inline-flex h-9 items-center border border-border px-3 text-xs hover:border-primary disabled:cursor-not-allowed disabled:opacity-50'
</script>

<svelte:head>
  <title>{docTitle('Updates', 'Settings')}</title>
</svelte:head>

<h2 class="text-base font-semibold tracking-tight">Updates</h2>

{#if !info.onBox}
  <p
    class="mt-6 rounded-lg border border-border px-4 py-3 text-sm text-foreground/60"
    data-testid="updates-unmanaged"
  >
    Updates are installed by the server this company runs on. This copy of eigenEnterprise is not
    running on such a server, so there is nothing to update here.
  </p>
{:else}
  <p class="mt-4 text-sm" data-testid="updates-installed">
    {#if info.installed}
      {@const p = parts(info.installed.tarball)}
      This server runs <strong>eigenEnterprise {p.version}</strong>
      {#if p.build}<span class="text-xs text-foreground/60">(build {p.build})</span>{/if}.
    {:else}
      This server has no eigenEnterprise release installed yet.
    {/if}
  </p>

  {#if job && job.status === 'succeeded' && !watched}
    <p class="mt-2 text-xs text-foreground/60" data-testid="updates-last">
      Last update: to {parts(job.installedAfter ?? job.release).version}{job.endedAt
        ? `, ${new Date(job.endedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
        : ''}.
    </p>
  {:else if job}
    <section
      class="mt-6 space-y-4"
      data-testid="updates-progress"
      data-status={job.status}
      data-step={job.step}
    >
      {#if job.status === 'running'}
        <p class="text-sm">
          Updating to <strong>eigenEnterprise {parts(job.release).version}</strong>. Keep this page
          open if you like — the update carries on without it, and this page reconnects while the
          server restarts.
        </p>
      {:else if job.status === 'succeeded'}
        <div class="rounded-lg border border-eigen-green/60 px-4 py-3" data-testid="updates-done">
          <p class="text-sm font-medium">
            Updated to eigenEnterprise {parts(job.installedAfter ?? job.release).version}.
          </p>
          <p class="mt-1 text-xs text-foreground/70">
            Everything was kept. A safety copy from just before the update stays on the server{job.safetyCopy
              ? ` (${job.safetyCopy})`
              : ''}.
          </p>
          <a
            href={resolve('/(nucleus)/settings/updates')}
            data-sveltekit-reload
            class="{secondary} mt-3">Reload the app</a
          >
        </div>
      {:else}
        <ErrorNotice
          class="rounded-lg border border-red-700/60 px-4 py-3"
          testid="updates-failed"
          title={`The update to ${parts(job.release).version} did not finish.`}
          error={job.error ?? 'ee did not say why.'}
          attempted={`Updating eigenEnterprise to ${job.release} (ee upgrade job ${job.id})`}
        >
          {#if job.safetyCopy}
            <p class="mt-2 text-xs text-foreground/70">
              The server keeps a safety copy from just before the update. To go back to it, run the
              steps in
              <code class="font-mono">{job.safetyCopy}/ROLLBACK.txt</code> on the server as root.
            </p>
          {:else}
            <p class="mt-2 text-xs text-foreground/70">
              It stopped before anything on the server was changed.
            </p>
          {/if}
        </ErrorNotice>
      {/if}

      {#if conn === 'offline' && job.status === 'running'}
        <p class="text-xs text-amber-700" data-testid="updates-offline">
          The server is restarting — reconnecting…
        </p>
      {:else if conn === 'signed-out'}
        <p class="text-xs text-foreground/70" data-testid="updates-signed-out">
          The server is back, but this page lost your sign-in. <a
            href={resolve('/login')}
            data-sveltekit-reload
            class="underline">Sign in again</a
          >
          to see the result here.
        </p>
      {/if}

      <ol class="space-y-1.5 text-xs" data-testid="updates-steps">
        {#each STEPS as s, i (s.label)}
          {@const st =
            i < current
              ? 'done'
              : i === current
                ? job.status === 'failed'
                  ? 'failed'
                  : 'now'
                : 'todo'}
          <li class="flex items-center gap-2" data-state={st}>
            <span
              class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-xs {st ===
              'done'
                ? 'border-eigen-green bg-eigen-green text-white'
                : st === 'now'
                  ? 'border-primary text-primary'
                  : st === 'failed'
                    ? 'border-red-700 bg-red-700 text-white'
                    : 'border-border text-muted-foreground'}"
              aria-hidden="true">{st === 'done' ? '✓' : st === 'failed' ? '!' : i + 1}</span
            >
            <span class={st === 'todo' ? 'text-muted-foreground' : ''}
              >{s.label}{st === 'now' && job.status === 'running' ? '…' : ''}</span
            >
          </li>
        {/each}
      </ol>

      {#if job.log.length > 0}
        <details class="text-xs text-foreground/60">
          <summary class="cursor-pointer">Details</summary>
          <pre
            class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border p-2 font-mono">{job.log.join(
              '\n',
            )}</pre>
        </details>
      {/if}
    </section>
  {/if}

  {#if info.managed}
    <p
      class="mt-6 rounded-lg border border-border px-4 py-3 text-sm text-foreground/70"
      data-testid="updates-managed"
    >
      Your hosting provider updates this server: new releases are installed for you.
    </p>
  {:else if job?.status !== 'running'}
    <section class="mt-6 space-y-3">
      {#if info.latest && !info.latest.ok}
        <ErrorNotice
          class="rounded-lg border border-red-700/60 px-4 py-3 text-xs"
          testid="updates-check-error"
          error={info.latest.error}
          agent={info.latest.agent}
        />
      {:else if latest && offered}
        <div class="space-y-3 rounded-lg border border-border p-4" data-testid="updates-available">
          <h3 class="text-sm font-semibold">
            {latest.state === 'rebuild'
              ? `A new build of eigenEnterprise ${latest.version} is available`
              : `eigenEnterprise ${latest.version} is available`}
          </h3>
          {#if latest.notes}
            <pre
              class="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-border p-3 font-mono text-xs text-foreground/80"
              data-testid="updates-notes">{latest.notes}</pre>
          {:else}
            <p class="text-xs text-foreground/60" data-testid="updates-notes">
              This release has no release notes.
            </p>
          {/if}
          <ul class="list-disc space-y-1 pl-5 text-xs text-foreground/70">
            <li>
              Its signature is checked first; nothing that isn't signed by eigenEnterprise is
              installed.
            </li>
            <li>
              A safety copy of the database and the server's settings is taken before anything
              changes.
            </li>
            <li>
              The company stays online: the new version takes over only once it answers, so most
              people won't notice.
            </li>
          </ul>
          <form
            method="post"
            action="?/update"
            data-testid="updates-start-form"
            data-release={latest.name}
            use:enhance={() => {
              busy = true
              return async ({ result, update }) => {
                await update({ reset: false })
                busy = false
                if (result.type === 'success' && result.data && 'job' in result.data) {
                  job = result.data.job as UpgradeJob
                  watched = true
                  void poll()
                }
              }
            }}
          >
            <input type="hidden" name="release" value={latest.name} />
            <button type="submit" class={primary} disabled={busy} data-testid="updates-start"
              >{busy ? 'Starting…' : `Update to ${latest.version}`}</button
            >
          </form>
        </div>
      {:else if latest}
        <p class="text-sm" data-testid="updates-current">
          {latest.state === 'older'
            ? `This server runs a newer version than the newest release (${latest.version}).`
            : 'eigenEnterprise is up to date.'}
        </p>
      {/if}
      {#if error}
        <ErrorNotice
          class="text-xs"
          testid="updates-error"
          error={error.error}
          agent={error.agent}
          attempted="Starting the update"
        />
      {/if}
      <a
        href={resolve('/(nucleus)/settings/updates')}
        data-sveltekit-reload
        class="text-xs text-foreground/60 underline hover:text-foreground">Check again</a
      >
    </section>
  {/if}
{/if}
