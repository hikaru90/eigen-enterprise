<script lang="ts">
  /**
   * The build contract form, for repos without an ee.json. What it says is
   * stored in the company repo by the server (never in the app's repo).
   * Runtimes come from the server's catalog only (D16).
   *
   * "Let AI fill this out" asks the server (POST /m/website/apps/suggest),
   * which reads the repo through ee's mirror and has the model propose the
   * fields. It fills them, marks what it set, and shows its reasons; the owner
   * edits freely before deploying.
   */
  import type { ContractSuggestion, SuggestedFields } from '../../../modules/website/apps/suggest'

  type Fields = Omit<SuggestedFields, 'runtime'> & { runtime: string }
  type Target = { name: string; repo?: string; branch?: string }

  let {
    nodeVersions,
    open = false,
    target,
    initial,
    onsuggested,
  }: {
    nodeVersions: string[]
    open?: boolean
    /** What to read: the app name and (for a new app) its repo + branch; null until picked. */
    target: Target | null
    /** Values to start from (a redeploy's stored contract). */
    initial?: Partial<Fields>
    /** Called with the suggestion once it has filled the fields (e.g. to set the app kind). */
    onsuggested?: (s: ContractSuggestion) => void
  } = $props()

  const defaults = (): Fields => ({
    runtime: nodeVersions[0] ? `node@${nodeVersions[0]}` : 'static',
    install: 'npm install --omit=dev',
    build: '',
    start: 'node index.js',
    portEnv: '',
    health: '/',
    staticDir: '',
    ...initial,
  })

  let useForm = $state(open)
  let fields = $state<Fields>(defaults())
  let aiSet = $state<Partial<Record<keyof Fields, true>>>({})
  let phase = $state<'idle' | 'reading' | 'done' | 'failed'>('idle')
  let result = $state<ContractSuggestion | null>(null)
  let failure = $state('')

  const FAILED = "The AI couldn't fill this in right now. Try again, or fill the form in yourself."

  async function suggest() {
    if (!target) return
    phase = 'reading'
    failure = ''
    try {
      const res = await fetch('/m/website/apps/suggest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(target),
      })
      const body = (await res.json().catch(() => null)) as {
        suggestion?: ContractSuggestion
        error?: string
      } | null
      if (!res.ok || !body?.suggestion) {
        failure = typeof body?.error === 'string' ? body.error : FAILED
        phase = 'failed'
        return
      }
      apply(body.suggestion)
    } catch {
      failure = FAILED
      phase = 'failed'
    }
  }

  function apply(s: ContractSuggestion) {
    const { runtime, ...rest } = s.fields
    const next: Fields = { ...fields, ...rest, ...(runtime ? { runtime } : {}) }
    const set: Partial<Record<keyof Fields, true>> = {}
    for (const k of Object.keys(next) as (keyof Fields)[]) {
      const suggested = k === 'runtime' ? runtime : s.fields[k]
      if (suggested) set[k] = true
    }
    fields = next
    aiSet = set
    result = s
    useForm = true
    phase = 'done'
    onsuggested?.(s)
  }

  const edited = (k: keyof Fields) => () => {
    if (aiSet[k]) aiSet = { ...aiSet, [k]: undefined }
  }

  const inputClass = (k: keyof Fields, mono = true) =>
    `rounded-md border bg-background px-2 py-1.5 ${mono ? 'font-mono text-xs' : ''} ${
      aiSet[k] ? 'border-sky-500 ring-1 ring-sky-500/40' : 'border-border'
    }`
</script>

<fieldset class="flex flex-col gap-3 rounded-md border border-border p-4">
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      onclick={suggest}
      disabled={!target || phase === 'reading'}
      class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40 disabled:opacity-60"
    >
      {#if phase === 'reading'}
        <span
          class="size-3.5 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground"
          aria-hidden="true"
        ></span>
      {/if}
      Let AI fill this out
    </button>
    {#if phase === 'reading'}
      <span class="text-xs text-foreground/60" role="status">Reading the repo…</span>
    {:else if !target}
      <span class="text-xs text-muted-foreground">Pick a repo first.</span>
    {:else if phase === 'done'}
      <span class="text-xs text-foreground/60" role="status"
        >Filled in from the repo — fields it set are outlined. Check them before deploying.</span
      >
    {/if}
  </div>
  {#if phase === 'failed'}
    <p class="text-sm text-red-600" role="alert">{failure}</p>
  {/if}
  {#if phase === 'done' && result}
    <div class="flex flex-col gap-1 rounded-md bg-muted/40 p-3 text-xs">
      {#if result.catalogGap}
        <p class="text-sm text-amber-700 dark:text-amber-400">{result.catalogGap}</p>
      {/if}
      {#each result.reasons as r, i (i)}
        <p class="text-foreground/70">{r}</p>
      {/each}
      {#each result.warnings as w, i (i)}
        <p class="text-amber-700 dark:text-amber-400">{w}</p>
      {/each}
      {#if result.filesRead.length > 0}
        <p class="text-muted-foreground">Read: {result.filesRead.join(', ')}</p>
      {/if}
    </div>
  {/if}

  <label class="flex items-center gap-2 text-sm">
    <input type="checkbox" name="useForm" bind:checked={useForm} />
    This repo has no ee.json — tell Eigen how to build and start it
  </label>
  {#if useForm}
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="flex flex-col gap-1 text-sm">
        Runtime
        <select
          name="runtime"
          bind:value={fields.runtime}
          onchange={edited('runtime')}
          data-ai-set={aiSet.runtime ? 'true' : undefined}
          class={inputClass('runtime', false)}
        >
          {#each nodeVersions as v (v)}
            <option value={`node@${v}`}>Node.js {v}</option>
          {/each}
          <option value="static">Static files</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Health check path
        <input
          name="health"
          bind:value={fields.health}
          oninput={edited('health')}
          data-ai-set={aiSet.health ? 'true' : undefined}
          class={inputClass('health', false)}
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Install command
        <input
          name="install"
          bind:value={fields.install}
          oninput={edited('install')}
          data-ai-set={aiSet.install ? 'true' : undefined}
          class={inputClass('install')}
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Build command (optional)
        <input
          name="build"
          placeholder="npm run build"
          bind:value={fields.build}
          oninput={edited('build')}
          data-ai-set={aiSet.build ? 'true' : undefined}
          class={inputClass('build')}
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Start command
        <input
          name="start"
          bind:value={fields.start}
          oninput={edited('start')}
          data-ai-set={aiSet.start ? 'true' : undefined}
          class={inputClass('start')}
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Port variable (optional)
        <input
          name="portEnv"
          placeholder="PORT is always set"
          bind:value={fields.portEnv}
          oninput={edited('portEnv')}
          data-ai-set={aiSet.portEnv ? 'true' : undefined}
          class={inputClass('portEnv')}
        />
      </label>
      <label class="flex flex-col gap-1 text-sm sm:col-span-2">
        Folder to serve (static sites only)
        <input
          name="staticDir"
          placeholder="dist"
          bind:value={fields.staticDir}
          oninput={edited('staticDir')}
          data-ai-set={aiSet.staticDir ? 'true' : undefined}
          class={inputClass('staticDir')}
        />
      </label>
    </div>
    <p class="text-xs text-muted-foreground">
      Commands run directly, not through a shell. The app must listen on the port in PORT.
    </p>
  {/if}
</fieldset>
