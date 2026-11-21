<script lang="ts">
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link'
  import PlayIcon from '@lucide/svelte/icons/play'
  import RotateCwIcon from '@lucide/svelte/icons/rotate-cw'
  import SquareIcon from '@lucide/svelte/icons/square'
  import { onDestroy, onMount, tick } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import {
    DriveApiError,
    driveApi,
    type AppPreview,
    type AppStatus,
    type PreviewState,
  } from '$lib/drive/api'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { ShownError } from '$lib/errors/agent-report'

  /**
   * A web app folder on its folder page (plan/phase-drive-app-preview.md):
   * owner and admins get Run app (with a lockfile warning when there is
   * none); once started, a panel with its state, the log tail, Stop, Restart,
   * Open in new tab and the app in a frame at its own origin. While it is
   * open the page asks for the status (which keeps the preview from idling
   * out) every 5 s while installing/starting and every 30 s while running —
   * explicit timers, started by onMount and the handlers, stopped on destroy.
   * Everyone else who can open the folder sees a running app, without controls.
   */
  let { folderId, canRun }: { folderId: string; canRun: boolean } = $props()

  const POLL_SETTLING_MS = 5_000
  const POLL_RUNNING_MS = 30_000

  let status = $state<AppStatus | null>(null)
  let loadError = $state<ShownError | null>(null)
  let actionError = $state<ShownError | null>(null)
  let busyWith = $state<AppPreview | null>(null)
  let acting = $state(false)
  let logEl = $state<HTMLPreElement | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false

  const preview = $derived(status?.preview ?? null)
  const active = $derived(preview !== null && preview.state !== 'stopped')
  const shown = $derived((canRun && status?.webApp != null) || active)

  const STATE_LABEL: Record<PreviewState, string> = {
    installing: 'Installing dependencies…',
    starting: 'Starting the dev server…',
    running: 'Running',
    failed: 'Failed',
    stopped: 'Stopped',
  }

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function schedule() {
    clearTimer()
    if (destroyed) return
    const s = status?.preview?.state
    const delay =
      s === 'installing' || s === 'starting'
        ? POLL_SETTLING_MS
        : s === 'running'
          ? POLL_RUNNING_MS
          : null
    if (delay !== null) timer = setTimeout(refresh, delay)
  }

  async function showLogEnd() {
    await tick()
    logEl?.scrollTo({ top: logEl.scrollHeight })
  }

  async function refresh() {
    try {
      status = await driveApi.appStatus(folderId)
      loadError = null
      void showLogEnd()
    } catch (err) {
      loadError = driveShownError(err)
    } finally {
      schedule()
    }
  }

  const setPreview = (p: AppPreview) => {
    if (status) status = { ...status, preview: p }
  }

  async function act(run: () => Promise<void>) {
    acting = true
    actionError = null
    try {
      await run()
    } catch (err) {
      if (err instanceof DriveApiError && err.code === 'busy' && err.running) busyWith = err.running
      else actionError = driveShownError(err)
    } finally {
      acting = false
      schedule()
    }
  }

  const runApp = () =>
    act(async () => {
      busyWith = null
      setPreview((await driveApi.runApp(folderId)).preview)
      void showLogEnd()
    })
  const stopApp = () => act(async () => setPreview((await driveApi.stopApp(folderId)).preview))
  const stopOther = () =>
    act(async () => {
      if (!busyWith) return
      await driveApi.stopPreview(busyWith.id)
      busyWith = null
    })

  onMount(() => {
    void refresh()
  })
  onDestroy(() => {
    destroyed = true
    clearTimer()
  })
</script>

{#if loadError}
  <ErrorNotice
    class="px-4 pt-4 md:px-6"
    testid="drive-app-load-error"
    error={loadError.error}
    agent={loadError.agent}
    attempted="Reading the state of this folder’s app preview"
  />
{/if}

{#if status && shown}
  <section
    class="mx-4 mt-4 rounded-lg border border-border md:mx-6"
    aria-label="Web app"
    data-testid="drive-app"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-medium">Web app</h2>
        <p class="text-xs text-muted-foreground">
          {#if active && preview}
            <span data-testid="drive-app-state" data-state={preview.state}
              >{STATE_LABEL[preview.state]}</span
            >
          {:else if status.webApp}
            Runs <code class="font-mono">npm run {status.webApp.script}</code> on this server, in its
            own sandbox.
          {/if}
        </p>
      </div>
      {#if active && preview}
        {#if preview.state === 'running'}
          <Button
            href={preview.url}
            target="_blank"
            rel="external noopener noreferrer"
            variant="outline"
            size="sm"
            data-testid="drive-app-open"
          >
            <ExternalLinkIcon class="size-4" aria-hidden="true" /> Open in new tab
          </Button>
        {/if}
        {#if canRun}
          <Button
            variant="outline"
            size="sm"
            onclick={runApp}
            disabled={acting}
            data-testid="drive-app-restart"
          >
            <RotateCwIcon class="size-4" aria-hidden="true" /> Restart
          </Button>
          <Button
            variant="outline"
            size="sm"
            onclick={stopApp}
            disabled={acting}
            data-testid="drive-app-stop"
          >
            <SquareIcon class="size-4" aria-hidden="true" /> Stop
          </Button>
        {/if}
      {:else if canRun && status.webApp}
        <Button size="sm" onclick={runApp} disabled={acting} data-testid="drive-app-run">
          <PlayIcon class="size-4" aria-hidden="true" /> Run app
        </Button>
      {/if}
    </div>

    {#if !active && canRun}
      {#if status.webApp && status.webApp.lockfile === null}
        <p
          class="border-t border-border px-4 py-2 text-xs text-muted-foreground"
          data-testid="drive-app-no-lockfile"
        >
          There is no lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock) next to
          package.json, so Run will fail until one is added.
        </p>
      {/if}
      {#if !status.managed && status.reason}
        <p
          class="border-t border-border px-4 py-2 text-xs text-muted-foreground"
          data-testid="drive-app-unmanaged"
        >
          {status.reason}
        </p>
      {/if}
      {#if preview?.state === 'stopped' && preview.error}
        <p
          class="border-t border-border px-4 py-2 text-xs text-muted-foreground"
          data-testid="drive-app-stopped"
        >
          Stopped: {preview.error}
        </p>
      {/if}
    {/if}

    {#if busyWith}
      <div
        class="flex flex-wrap items-center gap-3 border-t border-border px-4 py-2 text-sm"
        role="status"
        data-testid="drive-app-busy"
      >
        <span class="min-w-0 flex-1">Another app is running: {busyWith.folderName}</span>
        {#if canRun}
          <Button
            variant="outline"
            size="sm"
            class="h-7"
            onclick={stopOther}
            disabled={acting}
            data-testid="drive-app-stop-other">Stop it</Button
          >
        {/if}
      </div>
    {/if}

    {#if actionError}
      <ErrorNotice
        class="border-t border-border px-4 py-2"
        testid="drive-app-error"
        error={actionError.error}
        agent={actionError.agent}
        attempted="Running or stopping this folder’s app preview"
      />
    {/if}

    {#if active && preview}
      {#if preview.state === 'failed' && preview.error}
        <ErrorNotice
          class="border-t border-border px-4 py-2"
          testid="drive-app-failed"
          error={preview.error}
          attempted={`Running ${preview.folderName} as an app preview (the dev server failed; the log is below)`}
        />
      {/if}
      {#if preview.log.length > 0}
        <pre
          bind:this={logEl}
          class="max-h-48 overflow-auto border-t border-border bg-muted/40 px-4 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap"
          data-testid="drive-app-log">{preview.log.join('\n')}</pre>
      {/if}
      {#if preview.state === 'running'}
        <iframe
          title="App preview: {preview.folderName}"
          src={preview.url}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          class="block h-[70vh] w-full rounded-b-lg border-t border-border bg-white"
          data-testid="drive-app-frame"
        ></iframe>
      {/if}
    {/if}
  </section>
{/if}
