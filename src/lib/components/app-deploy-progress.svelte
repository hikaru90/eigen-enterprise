<script lang="ts" module>
  export type DeployStage = 'fetching' | 'building' | 'starting' | 'health' | 'live' | 'failed'

  /** What the deploy-progress route returns (modules/website/apps/deploy-jobs.ts). */
  export type DeployProgressView = {
    jobId: string
    name: string
    state: 'running' | 'live' | 'failed'
    stage: DeployStage
    stages: Array<{ stage: DeployStage; at: string }>
    failedStage: DeployStage | null
    error: string | null
    deployId: string | null
    lines: string[]
  }

  export type ContractChanges = Partial<
    Record<'install' | 'build' | 'start' | 'health' | 'nodeVersion' | 'portEnv', string>
  >

  type Diagnosis = {
    cause: string
    fix: string
    suggestedContractChanges?: ContractChanges | null
    contractSource: 'repo' | 'form'
  }

  const STEPS: Array<{ stage: DeployStage; label: string }> = [
    { stage: 'fetching', label: 'Fetching' },
    { stage: 'building', label: 'Building' },
    { stage: 'starting', label: 'Starting' },
    { stage: 'health', label: 'Health check' },
    { stage: 'live', label: 'Live' },
  ]

  const CHANGE_LABELS: Record<keyof ContractChanges, string> = {
    install: 'Install command',
    build: 'Build command',
    start: 'Start command',
    health: 'Health path',
    nodeVersion: 'Node.js version',
    portEnv: 'Port variable',
  }

  export const POLL_MS = 1500
</script>

<script lang="ts">
  /**
   * A deploy in progress (spinner, current stage, live log), and on failure
   * the plain cause, the log tail and "Ask AI what went wrong". Polling is
   * started by `follow(jobId)` from a click handler (never an $effect).
   */
  let {
    name,
    initial = null,
    onlive,
  }: {
    name: string
    initial?: DeployProgressView | null
    onlive?: () => void
  } = $props()

  // Seeded once from the page's last attempt; then owned by the polling loop.
  // svelte-ignore state_referenced_locally
  let progress = $state<DeployProgressView | null>(initial)
  // svelte-ignore state_referenced_locally
  let appName = $state(name)
  let pollError = $state<string | null>(null)
  let diagnosing = $state(false)
  let diagnosis = $state<Diagnosis | null>(null)
  let diagnoseError = $state<string | null>(null)
  let applying = $state(false)
  let loop = 0

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const base = () => `/m/website/apps/${encodeURIComponent(appName)}`

  /** Follow a background deploy until it ends. A newer call replaces an older loop. */
  export async function follow(jobId: string, forName: string = name): Promise<void> {
    const mine = ++loop
    appName = forName
    pollError = null
    diagnosis = null
    diagnoseError = null
    progress = {
      jobId,
      name: forName,
      state: 'running',
      stage: 'fetching',
      stages: [],
      failedStage: null,
      error: null,
      deployId: null,
      lines: [],
    }
    while (mine === loop) {
      try {
        const res = await fetch(`${base()}/deploy-progress?job=${encodeURIComponent(jobId)}`)
        const body = (await res.json()) as DeployProgressView | { error: string }
        if (mine !== loop) return
        if ('error' in body && !('state' in body)) {
          pollError = body.error
          return
        }
        progress = body as DeployProgressView
        if (progress.state === 'live') {
          onlive?.()
          return
        }
        if (progress.state === 'failed') return
      } catch {
        pollError =
          'Lost contact with this server while following the deploy. Reload the page to see where it is.'
        return
      }
      await sleep(POLL_MS)
    }
  }

  /** Start a redeploy (optionally with the AI's contract changes) and follow it. */
  export async function redeploy(changes?: ContractChanges): Promise<void> {
    applying = true
    pollError = null
    try {
      const res = await fetch(`${base()}/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes ? { changes } : {}),
      })
      const body = (await res.json()) as { jobId?: string; error?: string }
      if (!res.ok || !body.jobId) {
        pollError = body.error ?? 'The deploy could not be started.'
        return
      }
      void follow(body.jobId, appName)
    } finally {
      applying = false
    }
  }

  async function askAi(deployId: string) {
    diagnosing = true
    diagnoseError = null
    diagnosis = null
    try {
      const res = await fetch(`${base()}/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deployId }),
      })
      const body = (await res.json()) as Diagnosis | { error: string }
      if ('error' in body) diagnoseError = body.error
      else diagnosis = body
    } catch {
      diagnoseError = 'Lost contact with this server. Try again.'
    } finally {
      diagnosing = false
    }
  }

  const reached = (p: DeployProgressView, stage: DeployStage) =>
    p.stages.some((s) => s.stage === stage)
  const when = (iso: string) => new Date(iso).toLocaleTimeString()
  const changeEntries = (c: ContractChanges) =>
    (Object.keys(c) as Array<keyof ContractChanges>).filter((k) => c[k] !== undefined)
</script>

{#if progress}
  <section
    class="flex flex-col gap-3 rounded-md border border-border p-4"
    aria-label="Deploy progress"
    data-testid="deploy-progress"
    data-state={progress.state}
  >
    <div class="flex flex-wrap items-center gap-2 text-sm">
      {#if progress.state === 'running'}
        <span
          class="inline-block size-4 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground"
          role="status"
          aria-label="Deploying"
        ></span>
        <span class="font-medium">Deploying {progress.name}…</span>
      {:else if progress.state === 'live'}
        <span class="font-medium text-green-700">{progress.name} is live.</span>
      {:else}
        <span class="font-medium text-red-600">The deploy of {progress.name} failed.</span>
      {/if}
    </div>

    <ol class="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Stages">
      {#each STEPS as step (step.stage)}
        {@const current = progress.stage === step.stage && progress.state === 'running'}
        {@const failedHere = progress.failedStage === step.stage}
        {@const at = progress.stages.find((s) => s.stage === step.stage)?.at}
        <li
          class={failedHere
            ? 'font-medium text-red-600'
            : current
              ? 'font-medium text-foreground'
              : reached(progress, step.stage)
                ? 'text-foreground/70'
                : 'text-foreground/35'}
          aria-current={current ? 'step' : undefined}
        >
          {step.label}{failedHere ? ' — failed' : ''}{at ? ` · ${when(at)}` : ''}
        </li>
      {/each}
    </ol>

    {#if progress.state === 'failed' && progress.error}
      <p class="text-sm text-red-600" role="alert">{progress.error}</p>
    {/if}
    {#if pollError}
      <p class="text-sm text-red-600" role="alert">{pollError}</p>
    {/if}

    {#if progress.lines.length > 0}
      <pre
        class="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap"
        aria-label="Deploy log">{progress.lines.join('\n')}</pre>
    {:else if progress.state === 'running'}
      <p class="text-xs text-foreground/55">
        The build and start output appears here as it happens.
      </p>
    {/if}

    {#if progress.state === 'failed' && progress.deployId}
      {@const deployId = progress.deployId}
      <div class="flex flex-col gap-2">
        <div>
          <button
            type="button"
            disabled={diagnosing}
            onclick={() => askAi(deployId)}
            class="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-60"
          >
            {diagnosing ? 'Asking the AI…' : 'Ask AI what went wrong'}
          </button>
        </div>
        {#if diagnoseError}
          <p class="text-sm text-red-600" role="alert">{diagnoseError}</p>
        {/if}
        {#if diagnosis}
          <div
            class="flex flex-col gap-2 rounded-md bg-muted/40 p-3 text-sm"
            aria-label="AI diagnosis"
          >
            <p><span class="font-medium">What went wrong:</span> {diagnosis.cause}</p>
            <p><span class="font-medium">How to fix it:</span> {diagnosis.fix}</p>
            {#if diagnosis.suggestedContractChanges && diagnosis.contractSource === 'form'}
              {@const changes = diagnosis.suggestedContractChanges}
              <ul class="flex flex-col gap-0.5 font-mono text-xs">
                {#each changeEntries(changes) as key (key)}
                  <li>{CHANGE_LABELS[key]}: {changes[key]}</li>
                {/each}
              </ul>
              <div>
                <button
                  type="button"
                  disabled={applying}
                  onclick={() => redeploy(changes)}
                  class="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-60"
                >
                  {applying ? 'Starting…' : 'Apply and redeploy'}
                </button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </section>
{/if}
