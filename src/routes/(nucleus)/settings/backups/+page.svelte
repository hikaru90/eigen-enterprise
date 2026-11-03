<script lang="ts">
  import type { PageProps } from './$types'
  import { onMount, untrack } from 'svelte'
  import { enhance } from '$app/forms'
  import { invalidateAll } from '$app/navigation'
  import type { BackupRun } from '$lib/server/ee/client'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: PageProps = $props()

  const backups = $derived(data.backups)
  const status = $derived(backups.managed ? backups.status : null)

  // Form fields (bound) — seeded once from the saved config.
  const initial = untrack(() => (data.backups.managed ? data.backups.status : null))
  const t = initial?.target ?? null
  let endpoint = $state(t?.endpoint ?? '')
  let region = $state(t?.region ?? '')
  let bucket = $state(t?.bucket ?? '')
  let prefix = $state(t?.prefix ?? '')
  let addressing = $state<'path' | 'virtual'>(t?.addressing ?? 'path')
  let accessKeyId = $state(t?.accessKeyId ?? '')
  let secretAccessKey = $state('')
  let hour = $state(initial?.schedule?.hour ?? 3)
  let retentionDays = $state(initial?.retentionDays ?? 30)

  const fieldsKey = $derived(
    JSON.stringify([endpoint, region, bucket, prefix, addressing, accessKeyId, secretAccessKey]),
  )
  /** The fields as they were when the connection test last passed. */
  let testedKey = $state<string | null>(null)
  const tested = $derived(testedKey === fieldsKey)
  let busy = $state<'test' | 'save' | 'run' | null>(null)

  // The recovery code: from the save response only; once dismissed it is gone for good.
  let codeDismissed = $state(false)
  let codeStored = $state(false)
  const recoveryCode = $derived(
    form?.action === 'save' && 'recoveryCode' in form && typeof form.recoveryCode === 'string' && !codeDismissed
      ? form.recoveryCode
      : null,
  )
  let copied = $state(false)

  const feedback = (action: string) =>
    form && form.action === action ? (form as { ok?: boolean; error?: string }) : null

  const running = $derived(status?.health.state === 'running')
  let polling = false
  async function pollWhileRunning() {
    if (polling) return
    polling = true
    try {
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        await invalidateAll()
        if (data.backups.managed && data.backups.status.health.state !== 'running') break
      }
    } finally {
      polling = false
    }
  }
  onMount(() => {
    if (running) void pollWhileRunning()
  })

  const pad = (n: number) => String(n).padStart(2, '0')
  function size(bytes: number | null): string {
    if (bytes === null) return '—'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  }
  function duration(ms: number | null): string {
    if (ms === null) return '—'
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`
    return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
  }
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const result = (r: BackupRun) =>
    r.status === 'succeeded' ? 'Succeeded' : r.status === 'failed' ? 'Failed' : 'Running…'

  async function copyCode(code: string) {
    await navigator.clipboard.writeText(code)
    copied = true
  }

  const input =
    'border-input bg-card h-9 w-full border px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring'
  const primary =
    'h-9 bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50'
  const secondary =
    'h-9 border border-border px-3 text-xs hover:border-primary disabled:cursor-not-allowed disabled:opacity-50'
</script>

<svelte:head>
  <title>{docTitle('Backups', 'Settings')}</title>
</svelte:head>

<h2 class="text-base font-semibold tracking-tight">Backups</h2>
<p class="mt-1 text-sm text-foreground/60">
  Every night the server copies the company — database, Drive files, the agent's memory and the
  server's own settings — to a storage bucket you choose. Everything is encrypted on this server
  before it leaves; the bucket only ever sees scrambled data.
</p>

{#if !backups.managed}
  <p
    class="mt-8 rounded-lg border border-border px-4 py-3 text-sm text-foreground/60"
    data-testid="backups-unmanaged"
  >
    Backups are run by the server this company is installed on. This copy of eigenEnterprise is not
    running on such a server, so there is nothing to set up here.
  </p>
{:else if status}
  {#if recoveryCode}
    <section
      class="mt-8 space-y-3 rounded-lg border-2 border-amber-500/70 p-4"
      data-testid="backups-recovery-code"
    >
      <h3 class="text-sm font-semibold">Store your company recovery code safely</h3>
      <p class="text-xs text-foreground/70">
        Without it, your backups can't be read — not by you, not by us, not by anyone. It is the one
        recovery code of your company: the same code also unlocks the company's encrypted data. If
        this server is ever lost, you will need it to bring the company back. It is shown <strong
          >only this once</strong
        > here: put it in your password manager or print it and keep it somewhere safe.
      </p>
      <div class="flex gap-2">
        <input
          readonly
          value={recoveryCode}
          aria-label="Recovery code"
          data-testid="backups-recovery-code-value"
          class="border-input bg-card h-9 min-w-0 flex-1 border px-2.5 font-mono text-[12px] tracking-wide"
          onfocus={(e) => e.currentTarget.select()}
        />
        <button type="button" class={secondary} onclick={() => copyCode(recoveryCode)}
          >{copied ? 'Copied' : 'Copy'}</button
        >
      </div>
      <label class="flex items-center gap-2 text-xs">
        <input type="checkbox" bind:checked={codeStored} data-testid="backups-recovery-code-stored" />
        I have stored the recovery code somewhere safe
      </label>
      <button
        type="button"
        class={primary}
        disabled={!codeStored}
        onclick={() => (codeDismissed = true)}
        data-testid="backups-recovery-code-done">Done</button
      >
    </section>
  {:else}
    <!-- Status -->
    <section class="mt-8 space-y-3" data-testid="backups-status">
      <h3 class="text-sm font-semibold">Status</h3>
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
        <p class="text-sm" data-testid="backups-health" data-state={status.health.state}>
          {#if status.health.state === 'unconfigured'}
            Backups are not set up yet. Until they are, a broken server means lost data.
          {:else if status.health.state === 'ok'}
            Backups are working. Last good backup: {when(status.health.lastSuccessAt)}.
          {:else if status.health.state === 'running'}
            A backup is running now…
          {:else if status.health.state === 'failed'}
            <span class="text-red-700">The last backup failed: {status.health.error}</span>
          {:else}
            <span class="text-red-700">No backup ran last night — {status.health.message}.</span>
          {/if}
        </p>
        {#if status.configured}
          <form
            method="post"
            action="?/run"
            use:enhance={() => {
              busy = 'run'
              return async ({ update, result }) => {
                await update()
                busy = null
                if (result.type === 'success') void pollWhileRunning()
              }
            }}
          >
            <button
              type="submit"
              class={primary}
              disabled={running || busy === 'run'}
              data-testid="backups-run-now">{running ? 'Backing up…' : 'Back up now'}</button
            >
          </form>
        {/if}
      </div>
      {#if feedback('run')?.error}
        <p class="text-xs text-red-700">{feedback('run')?.error}</p>
      {/if}
      {#if status.schedule}
        <p class="text-xs text-foreground/60">
          Runs every night at {pad(status.schedule.hour)}:{pad(status.schedule.minute)} UTC and keeps
          {status.retentionDays} days of backups.
        </p>
      {/if}
    </section>

    <!-- Last runs -->
    {#if status.runs.length > 0}
      <section class="mt-10 space-y-3" data-testid="backups-runs">
        <h3 class="text-sm font-semibold">Last runs</h3>
        <div class="overflow-x-auto rounded-lg border border-border">
          <table class="w-full text-left text-xs">
            <thead class="text-foreground/55">
              <tr class="border-b border-border">
                <th class="px-3 py-2 font-medium">Started</th>
                <th class="px-3 py-2 font-medium">Result</th>
                <th class="px-3 py-2 font-medium">Uploaded</th>
                <th class="px-3 py-2 font-medium">Took</th>
                <th class="px-3 py-2 font-medium">How</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              {#each status.runs as r (r.id)}
                <tr data-testid="backups-run" data-status={r.status}>
                  <td class="px-3 py-2 whitespace-nowrap">{when(r.startedAt)}</td>
                  <td class="px-3 py-2">
                    <span class={r.status === 'failed' ? 'text-red-700' : ''}>{result(r)}</span>
                    {#if r.error}<span class="block text-[11px] text-foreground/60">{r.error}</span>{/if}
                  </td>
                  <td class="px-3 py-2 tabular-nums">{size(r.bytesUploaded)}</td>
                  <td class="px-3 py-2 tabular-nums">{duration(r.durationMs)}</td>
                  <td class="px-3 py-2">{r.trigger === 'scheduled' ? 'Nightly' : 'By hand'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    <!-- Setup -->
    <section class="mt-10 space-y-3" data-testid="backups-setup">
      <h3 class="text-sm font-semibold">{status.configured ? 'Storage bucket' : 'Set up backups'}</h3>
      <p class="text-xs text-foreground/60">
        Any S3-compatible storage works: Amazon S3, Hetzner Object Storage, Backblaze B2, MinIO. Create
        a bucket and an access key for it with your provider, then enter them here.
      </p>
      <form
        method="post"
        action="?/save"
        class="space-y-3"
        use:enhance={({ action }) => {
          const which = action.search.includes('test') ? 'test' : 'save'
          const key = fieldsKey
          busy = which
          return async ({ result, update }) => {
            if (which === 'test' && result.type === 'success') testedKey = key
            if (which === 'save' && result.type === 'success') {
              codeDismissed = false
              codeStored = false
              secretAccessKey = ''
              testedKey = null
            }
            await update({ reset: false })
            busy = null
          }
        }}
      >
        <div class="space-y-1">
          <label class="text-xs" for="b-endpoint">Endpoint</label>
          <input id="b-endpoint" name="endpoint" class={input} required placeholder="https://fsn1.your-objectstorage.com" bind:value={endpoint} />
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <label class="text-xs" for="b-region">Region</label>
            <input id="b-region" name="region" class={input} required placeholder="eu-central-1" bind:value={region} />
          </div>
          <div class="space-y-1">
            <label class="text-xs" for="b-bucket">Bucket</label>
            <input id="b-bucket" name="bucket" class={input} required bind:value={bucket} />
          </div>
          <div class="space-y-1">
            <label class="text-xs" for="b-prefix">Folder in the bucket (optional)</label>
            <input id="b-prefix" name="prefix" class={input} placeholder="company-backups" bind:value={prefix} />
          </div>
          <div class="space-y-1">
            <label class="text-xs" for="b-addressing">Addressing</label>
            <select id="b-addressing" name="addressing" class="border-input bg-card h-9 w-full border px-2 text-xs" bind:value={addressing}>
              <option value="path">Path-style (MinIO, most providers)</option>
              <option value="virtual">Virtual-host (Amazon S3)</option>
            </select>
          </div>
          <div class="space-y-1">
            <label class="text-xs" for="b-access">Access key</label>
            <input id="b-access" name="accessKeyId" class={input} required autocomplete="off" bind:value={accessKeyId} />
          </div>
          <div class="space-y-1">
            <label class="text-xs" for="b-secret">Secret key</label>
            <input
              id="b-secret"
              name="secretAccessKey"
              type="password"
              class={input}
              required={!status.configured}
              autocomplete="off"
              placeholder={status.configured ? 'Unchanged' : ''}
              bind:value={secretAccessKey}
            />
          </div>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <label class="text-xs" for="b-hour">Back up every night at</label>
            <select id="b-hour" name="hour" class="border-input bg-card h-9 w-full border px-2 text-xs" bind:value={hour}>
              {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}
                <option value={h}>{pad(h)}:xx UTC</option>
              {/each}
            </select>
          </div>
          <div class="space-y-1">
            <label class="text-xs" for="b-retention">Keep backups for (days)</label>
            <input id="b-retention" name="retentionDays" type="number" min="1" max="3650" class={input} required bind:value={retentionDays} />
          </div>
        </div>
        <p class="text-[11px] text-foreground/50">
          The exact minute is picked at random, so not every company hits its storage at the same moment.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <button type="submit" formaction="?/test" class={secondary} disabled={busy !== null} data-testid="backups-test">
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button type="submit" class={primary} disabled={!tested || busy !== null} data-testid="backups-save">
            {busy === 'save' ? 'Saving…' : status.configured ? 'Save changes' : 'Save and turn on backups'}
          </button>
          {#if !tested}
            <span class="text-[11px] text-foreground/50">Test the connection first.</span>
          {/if}
        </div>
        {#if feedback('test')?.ok && tested}
          <p class="text-xs text-eigen-green" data-testid="backups-test-ok">Connection works: ee wrote, read back and deleted a test file.</p>
        {:else if feedback('test')?.error}
          <p class="text-xs text-red-700" data-testid="backups-test-error">{feedback('test')?.error}</p>
        {/if}
        {#if feedback('save')?.error}
          <p class="text-xs text-red-700" data-testid="backups-save-error">{feedback('save')?.error}</p>
        {:else if feedback('save')?.ok && !recoveryCode}
          <p class="text-xs text-foreground/60" data-testid="backups-saved">Saved.</p>
        {/if}
      </form>
    </section>

    <!-- How to restore -->
    <section class="mt-10 space-y-2 pb-10" data-testid="backups-restore-help">
      <h3 class="text-sm font-semibold">How to restore</h3>
      <ol class="list-decimal space-y-1.5 pl-5 text-xs text-foreground/70">
        <li>Get a fresh server and install eigenEnterprise on it, the same way as the first time.</li>
        <li>
          On the new server, run <code class="font-mono">ee restore --snapshot latest</code> with your bucket's
          details (<code class="font-mono">--endpoint --region --bucket --prefix --access-key-id</code>). It asks
          for the secret key and then for your company recovery code (<code class="font-mono">EE1-…</code>).
        </li>
        <li>
          The server downloads the backup, checks every file, and puts back the database, Drive, the agent's
          memory and its own settings. Then it starts the company again — the same people, messages and files.
        </li>
        <li>
          To check a backup without restoring anything, run <code class="font-mono">ee restore --verify</code>.
        </li>
      </ol>
    </section>
  {/if}
{/if}
