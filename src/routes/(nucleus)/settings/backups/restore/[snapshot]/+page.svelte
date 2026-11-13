<script lang="ts">
  import type { PageProps } from './$types'
  import { onMount, untrack } from 'svelte'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import type { RestoreJob, RestoreStep } from '$lib/server/ee/client'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: PageProps = $props()

  const info = $derived(data.restore)

  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })
  /** A snapshot id is its UTC start time: 20261103T031700Z. */
  const snapshotTime = (id: string) =>
    id.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')

  // The job as last heard from ee — seeded from the load, then from polling.
  let job = $state<RestoreJob | null>(untrack(() => (data.restore.managed ? data.restore.job : null)))
  /** live: ee answers; offline: the company is restarting (reconnecting); signed-out: back, but this sign-in is gone. */
  let conn = $state<'live' | 'offline' | 'signed-out'>('live')
  /** The owner chose to start over after a finished restore of this backup. */
  let dismissed = $state(false)

  const showProgress = $derived(
    !dismissed &&
      job !== null &&
      job.kind === 'restore' &&
      (job.status === 'running' || (info.managed && job.snapshotId === info.snapshotId)),
  )

  let confirmName = $state('')
  let recoveryCode = $state('')
  let showCode = $state(false)
  let busy = $state(false)
  const nameOk = $derived(
    info.managed && info.companyName !== null && confirmName.trim() === info.companyName.trim(),
  )
  const error = $derived(form && 'error' in form ? (form.error as string) : null)

  const STEPS: Array<{ label: string; steps: RestoreStep[] }> = [
    { label: 'Download the backup and check every file', steps: ['verifying'] },
    { label: 'Stop the company', steps: ['handover', 'stopping'] },
    { label: "Put back the server's own settings and secrets", steps: ['restoring-state'] },
    { label: 'Put back the database', steps: ['restoring-database'] },
    { label: "Put back Drive files and the agent's memory", steps: ['restoring-files'] },
    { label: 'Start the company again', steps: ['starting'] },
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
          res = await fetch(resolve('/(nucleus)/settings/backups/job'), {
            redirect: 'manual',
            headers: { accept: 'application/json' },
          })
        } catch {
          conn = 'offline'
          continue
        }
        // Signed out (the restored company doesn't know this sign-in) or no longer the owner.
        if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) {
          conn = 'signed-out'
          break
        }
        // ee or the whole company is restarting: Caddy's 502, our 503 — keep trying.
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
          conn = 'offline'
          continue
        }
        const body = (await res.json()) as { job: RestoreJob | null }
        conn = 'live'
        job = body.job
        if (!job || job.status !== 'running') break
      }
    } finally {
      polling = false
    }
  }

  onMount(() => {
    if (job?.kind === 'restore' && job.status === 'running') void poll()
    return () => {
      stopped = true
    }
  })

  const input =
    'border-input bg-card h-9 w-full border px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring'
  const danger =
    'h-9 bg-red-700 px-3 text-xs font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50'
  const secondary =
    'inline-flex h-9 items-center border border-border px-3 text-xs hover:border-primary disabled:cursor-not-allowed disabled:opacity-50'
</script>

<svelte:head>
  <title>{docTitle('Restore a backup', 'Settings')}</title>
</svelte:head>

<a href={resolve('/(nucleus)/settings/backups')} class="text-xs text-foreground/60 hover:text-foreground">← Backups</a>
<h2 class="mt-2 text-base font-semibold tracking-tight">Restore a backup</h2>

{#if !info.managed}
  <p class="mt-8 rounded-lg border border-border px-4 py-3 text-sm text-foreground/60" data-testid="restore-unmanaged">
    Backups are run by the server this company is installed on. This copy of eigenEnterprise is not
    running on such a server, so there is nothing to restore here.
  </p>
{:else if showProgress && job}
  <section class="mt-6 space-y-4" data-testid="restore-progress" data-status={job.status} data-step={job.step}>
    {#if job.status === 'running'}
      <p class="text-sm">
        Restoring the backup from <strong>{when(snapshotTime(job.snapshotId))}</strong>. Keep this page open — the
        company goes offline for a few minutes while it restarts, and this page reconnects by itself.
      </p>
    {:else if job.status === 'succeeded'}
      <div class="rounded-lg border border-eigen-green/60 px-4 py-3" data-testid="restore-done">
        <p class="text-sm font-medium">Restored.</p>
        <p class="mt-1 text-xs text-foreground/70">
          The company is back as it was on {when(snapshotTime(job.snapshotId))}. Everything after that moment is gone.
        </p>
        <a href={resolve('/')} data-sveltekit-reload class="{secondary} mt-3">Open the company</a>
      </div>
    {:else}
      <div class="rounded-lg border border-red-700/60 px-4 py-3" data-testid="restore-failed">
        <p class="text-sm font-medium text-red-700">The restore did not finish.</p>
        <p class="mt-1 text-xs text-foreground/70">{job.error}</p>
        <button type="button" class="{secondary} mt-3" onclick={() => (dismissed = true)}>Start over</button>
      </div>
    {/if}

    {#if conn === 'offline' && job.status === 'running'}
      <p class="text-xs text-amber-700" data-testid="restore-offline">
        The company is offline while it restarts — reconnecting…
      </p>
    {:else if conn === 'signed-out'}
      <div class="rounded-lg border border-border px-4 py-3" data-testid="restore-signed-out">
        <p class="text-sm">The company is back.</p>
        <p class="mt-1 text-xs text-foreground/70">
          Your sign-in is newer than the backup, so the restored company doesn't know it. Sign in again
          to continue; the result of the restore is shown in Settings → Backups.
        </p>
        <a href={resolve('/login')} data-sveltekit-reload class="{secondary} mt-3">Sign in</a>
      </div>
    {/if}

    <ol class="space-y-1.5 text-xs" data-testid="restore-steps">
      {#each STEPS as s, i (s.label)}
        {@const st =
          i < current ? 'done' : i === current ? (job.status === 'failed' ? 'failed' : 'now') : 'todo'}
        <li class="flex items-center gap-2" data-state={st}>
          <span
            class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-xs {st === 'done'
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

    {#if job.checked}
      <p class="text-xs text-foreground/60">
        Checked: {job.checked.files.length} file(s) and {job.checked.blobs} Drive file(s) decrypt and match
        the backup.
      </p>
    {/if}
    {#if job.log.length > 0}
      <details class="text-xs text-foreground/60">
        <summary class="cursor-pointer">Details</summary>
        <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border p-2 font-mono">{job.log.join('\n')}</pre>
      </details>
    {/if}
  </section>
{:else if !info.configured}
  <p class="mt-8 rounded-lg border border-border px-4 py-3 text-sm text-foreground/60">
    Backups are not set up on this server, so there is nothing to restore. <a href={resolve('/(nucleus)/settings/backups')} class="underline">Set them up</a>.
  </p>
{:else}
  <section class="mt-6 space-y-4" data-testid="restore-confirm">
    <div class="space-y-2 rounded-lg border-2 border-red-700/60 p-4">
      <h3 class="text-sm font-semibold">This replaces the whole company with the backup from {when(info.takenAt)}</h3>
      <ul class="list-disc space-y-1 pl-5 text-xs text-foreground/75">
        <li>
          <strong>Everything since that moment is lost</strong>: messages, Drive files and their
          revisions, members and invitations, settings, and what the agent learned.
        </li>
        <li>
          Restoring is <strong>whole-company only</strong>: the database, Drive, the agent's memory and the
          server's own settings all go back together. You can't pick single files or messages.
        </li>
        <li>
          First the server downloads the whole backup and checks every file. If anything doesn't match,
          nothing on this server is changed.
        </li>
        <li>
          Then the company goes offline for a few minutes and starts again. Anyone signed in after the
          backup was taken has to sign in again.
        </li>
      </ul>
      <p class="text-xs text-foreground/60">
        Might you want today's state back later? <a href={resolve('/(nucleus)/settings/backups')} class="underline">Back up now</a> first.
      </p>
    </div>

    {#if job && job.kind === 'restore' && job.status !== 'running'}
      <p class="text-xs text-foreground/60" data-testid="restore-last">
        Last restore: backup {job.snapshotId}, {job.status === 'succeeded' ? 'restored' : `failed — ${job.error}`}.
      </p>
    {/if}

    {#if info.companyName === null}
      <p class="text-xs text-red-700">
        This company has no name yet. <a href={resolve('/(nucleus)/settings/company')} class="underline">Name it in Settings → Company</a>
        first — restoring asks you to type it.
      </p>
    {:else}
      <form
        method="post"
        action="?/restore"
        class="space-y-3"
        use:enhance={() => {
          busy = true
          return async ({ result, update }) => {
            await update({ reset: false })
            busy = false
            if (result.type === 'success' && result.data && 'job' in result.data) {
              job = result.data.job as RestoreJob
              recoveryCode = ''
              dismissed = false
              void poll()
            }
          }
        }}
      >
        <div class="space-y-1">
          <label class="text-xs" for="r-code">Company recovery code</label>
          <div class="flex gap-2">
            <input
              id="r-code"
              name="recoveryCode"
              type={showCode ? 'text' : 'password'}
              class="{input} font-mono"
              required
              autocomplete="off"
              spellcheck="false"
              placeholder="EE1-…"
              data-testid="restore-code"
              bind:value={recoveryCode}
            />
            <button type="button" class={secondary} onclick={() => (showCode = !showCode)}
              >{showCode ? 'Hide' : 'Show'}</button
            >
          </div>
          <p class="text-xs text-muted-foreground">
            The code you stored when backups were set up. It opens the backup; it is not saved anywhere.
          </p>
        </div>
        <div class="space-y-1">
          <label class="text-xs" for="r-name">Type <strong>{info.companyName}</strong> to confirm</label>
          <input
            id="r-name"
            name="confirmName"
            class={input}
            required
            autocomplete="off"
            data-testid="restore-confirm-name"
            bind:value={confirmName}
          />
        </div>
        <button
          type="submit"
          class={danger}
          disabled={!nameOk || recoveryCode.trim() === '' || busy}
          data-testid="restore-submit">{busy ? 'Starting…' : 'Restore this backup'}</button
        >
        {#if error}
          <p class="text-xs text-red-700" data-testid="restore-error">{error}</p>
        {/if}
      </form>
    {/if}
  </section>
{/if}
