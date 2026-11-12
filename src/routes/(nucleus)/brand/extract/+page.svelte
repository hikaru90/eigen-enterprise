<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import SourceOptions from './source-options.svelte'
  import SpecimenMini from './specimen-mini.svelte'
  import { docTitle } from '$lib/shell/title'

  type Candidate = { label: string; cssVars?: Record<string, string>; error?: string }
  type GuideMeta = { filename: string; mime: string; sizeBytes: number }

  /** A typed failure the server answered in plain words ({ message, code }), e.g. no browser for capture. */
  class PlainError extends Error {
    readonly code: string
    constructor(message: string, code: string) {
      super(message)
      this.code = code
    }
  }

  let { data }: { data: PageData } = $props()

  let name = $state('')
  let note = $state('')
  let sessionId = $state(data.initial?.session.id ?? '')
  let sessionUrl = $state(data.initial?.session.url ?? '')
  let sessionTitle = $state(data.initial?.session.title ?? '')
  let screenshotB64 = $state(data.initial?.screenshotB64 ?? '')
  let guide = $state<GuideMeta | null>(data.initial?.guide ?? null)
  let captureError = $state('')
  let uploadError = $state('')
  let currentRound = $state<number | null>(data.initial?.latestRound?.round ?? null)
  let candidates = $state<Candidate[]>(data.initial?.latestRound?.candidates ?? [])
  let roundJudged = $state<boolean>((data.initial?.latestRound?.verdict ?? null) !== null)
  let judged = $state<{ round: number; chosen: number; candidate: Candidate | null } | null>(
    data.initial?.judged ?? null,
  )
  let acceptedItem = $state<unknown>(null)
  let busy = $state(false)
  let error = $state('')

  const candidateCount = $derived(candidates.filter((c) => !c.error).length)
  const canAccept = $derived(sessionId !== '' && !busy && judged !== null && name.trim().length > 0)

  async function readResult(path: string, response: Response): Promise<Record<string, unknown>> {
    const text = await response.text()
    if (!response.ok) {
      const body = parsedObject(text)
      if (typeof body?.message === 'string' && typeof body.code === 'string') {
        throw new PlainError(body.message, body.code)
      }
      throw new Error(`${path} failed (${response.status}): ${text.slice(0, 400)}`)
    }
    return JSON.parse(text) as Record<string, unknown>
  }

  function parsedObject(text: string): Record<string, unknown> | null {
    try {
      const value: unknown = JSON.parse(text)
      return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return readResult(path, response)
  }

  async function loadSession(id: string): Promise<void> {
    const response = await fetch(`/api/brand/extract/session/${id}`)
    if (!response.ok) throw new Error(`session fetch failed (${response.status})`)
    const result = (await response.json()) as {
      session: { url: string | null; title: string | null }
      guide: GuideMeta | null
      rounds: Array<{ round: number; screenshotB64: string }>
    }
    sessionUrl = result.session.url ?? ''
    sessionTitle = result.session.title ?? ''
    guide = result.guide
    screenshotB64 = result.rounds[0]?.screenshotB64 ?? ''
  }

  /** Opens the session, then asks for the first round of three looks. */
  async function begin(
    open: () => Promise<Record<string, unknown>>,
    onPlainError: (message: string) => void,
  ): Promise<void> {
    busy = true
    error = ''
    captureError = ''
    uploadError = ''
    try {
      const result = await open()
      sessionId = String(result.sessionId)
      sessionTitle = String(result.title ?? '')
      await loadSession(sessionId)
      await propose()
    } catch (err) {
      if (err instanceof PlainError && sessionId === '') onPlainError(err.message)
      else error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function startFromUrl(url: string): Promise<void> {
    return begin(
      () => post('/api/brand/extract/start', { url }),
      (message) => (captureError = message),
    )
  }

  function startFromGuide(file: File): Promise<void> {
    const form = new FormData()
    form.append('file', file)
    return begin(
      async () =>
        readResult(
          '/api/brand/extract/guide',
          await fetch('/api/brand/extract/guide', { method: 'POST', body: form }),
        ),
      (message) => (uploadError = message),
    )
  }

  async function propose(): Promise<void> {
    const result = await post('/api/brand/extract/propose', { sessionId })
    currentRound = Number(result.round)
    candidates = result.candidates as Candidate[]
    roundJudged = false
  }

  async function retryPropose(): Promise<void> {
    busy = true
    error = ''
    try {
      await propose()
      note = ''
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function judge(chosen: number | null): Promise<void> {
    if (currentRound === null) return
    busy = true
    error = ''
    try {
      await post('/api/brand/extract/judge', {
        sessionId,
        round: currentRound,
        chosen,
        ...(chosen !== null || note.trim() ? { note: note.trim() } : {}),
      })
      if (chosen !== null) {
        judged = { round: currentRound, chosen, candidate: candidates[chosen] ?? null }
      }
      await propose()
      note = ''
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function accept(): Promise<void> {
    busy = true
    error = ''
    try {
      const result = await post('/api/brand/extract/accept', { sessionId, name: name.trim() })
      acceptedItem = result.corpusItem
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

<svelte:head>
  <title>{docTitle('Extract', 'Brand')}</title>
</svelte:head>

<div class="mt-8 flex w-full flex-col gap-6">
  <header>
    <h2 class="text-base font-semibold tracking-tight">Brand extraction judge</h2>
    <p class="mt-1 text-sm text-muted-foreground">
      Capture a public site or upload your brand guide, judge three seed candidates per round, stage
      the winner. Staging is not publishing — promotion happens through the activation gate later.
    </p>
  </header>

  {#if error}
    <pre
      class="whitespace-pre-wrap rounded border border-red-400 bg-red-50 p-3 text-xs text-red-800">{error}</pre>
  {/if}

  {#if acceptedItem}
    <section class="flex flex-col gap-3">
      <h2 class="text-lg font-medium">Staged corpus item</h2>
      <pre class="max-h-96 overflow-auto rounded border bg-neutral-100 p-3 text-xs">{JSON.stringify(
          acceptedItem,
          null,
          2,
        )}</pre>
      <a class="text-sm underline" href={resolve('/brand/extract')}>Start another extraction</a>
    </section>
  {:else}
    {#if !sessionId}
      <SourceOptions
        {busy}
        {captureError}
        {uploadError}
        oncapture={(url) => void startFromUrl(url)}
        onupload={(file) => void startFromGuide(file)}
      />
    {:else}
      <p class="text-sm text-neutral-600">
        Session <code>{sessionId}</code>{sessionTitle ? ` — ${sessionTitle}` : ''}{sessionUrl
          ? ` (${sessionUrl})`
          : ''}
      </p>

      {#if candidates.length > 0 && !roundJudged}
        <section class="flex flex-col gap-3">
          <h2 class="text-lg font-medium">Round {currentRound} — pick the closest</h2>
          <div class="flex flex-row items-stretch gap-4 overflow-x-auto">
            {#each candidates as candidate, index (index)}
              <div class="flex w-96 shrink-0 flex-col gap-2">
                <SpecimenMini title={sessionTitle || 'Untitled site'} {candidate} />
                <button
                  type="button"
                  class="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                  disabled={busy || candidate.error !== undefined}
                  onclick={() => void judge(index)}
                >
                  Closest
                </button>
              </div>
            {/each}
          </div>
          <div class="flex flex-col gap-2 rounded border p-3">
            <label class="text-sm font-medium" for="reject-note">
              None of these — retry with a corrective note (optional)
            </label>
            <textarea
              id="reject-note"
              class="w-full rounded border p-2 text-sm"
              rows="2"
              bind:value={note}
              placeholder="e.g. too corporate, warmer neutrals, keep the rounded corners"
            ></textarea>
            <button
              type="button"
              class="self-start rounded border px-3 py-2 text-sm disabled:opacity-50"
              disabled={busy}
              onclick={() => void judge(null)}
            >
              Reject round & repropose
            </button>
          </div>
        </section>
      {/if}

      {#if roundJudged && !judged}
        <section class="flex flex-col gap-2">
          <p class="text-sm">Round {currentRound} was rejected. Next round is loading…</p>
          <button
            type="button"
            class="self-start rounded border px-3 py-2 text-sm disabled:opacity-50"
            disabled={busy}
            onclick={() => void retryPropose()}
          >
            Propose now
          </button>
        </section>
      {/if}

      {#if judged}
        <section class="flex flex-col gap-3 rounded border-2 border-neutral-900 p-4">
          <h2 class="text-lg font-medium">
            Chosen from round {judged.round}: {judged.candidate?.label ?? 'candidate'}
          </h2>
          {#if judged.candidate}
            <SpecimenMini title={sessionTitle || 'Untitled site'} candidate={judged.candidate} />
          {/if}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium" for="corpus-name">Corpus item name</label>
            <input
              id="corpus-name"
              class="w-full max-w-sm rounded border px-3 py-2 text-sm"
              type="text"
              placeholder="e.g. Kindred web"
              bind:value={name}
            />
            <button
              type="button"
              class="self-start rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
              disabled={!canAccept}
              onclick={() => void accept()}
            >
              Accept this candidate
            </button>
          </div>
        </section>
      {/if}

      {#if screenshotB64}
        <section class="flex flex-col gap-2">
          <h2 class="text-lg font-medium">Live capture for comparison</h2>
          <img
            class="w-full max-w-3xl rounded border"
            alt="Captured site"
            src={`data:image/jpeg;base64,${screenshotB64}`}
          />
        </section>
      {/if}

      {#if guide}
        {@const guideHref = resolve('/api/brand/extract/session/[id]/guide', { id: sessionId })}
        <section class="flex flex-col gap-2" data-testid="extract-guide-preview">
          <h2 class="text-lg font-medium">Your brand guide for comparison</h2>
          {#if guide.mime === 'application/pdf'}
            <iframe
              class="min-h-[70vh] w-full max-w-3xl rounded border"
              title={guide.filename}
              src={guideHref}
            ></iframe>
          {:else}
            <img class="w-full max-w-3xl rounded border" alt={guide.filename} src={guideHref} />
          {/if}
          <a class="text-sm underline" href={guideHref} target="_blank" rel="noopener noreferrer"
            >Open “{guide.filename}”</a
          >
        </section>
      {/if}

      {#if candidateCount === 0 && candidates.length > 0 && !roundJudged}
        <p class="text-sm text-red-700">All three candidates this round were invalid.</p>
      {/if}
    {/if}
  {/if}
</div>
