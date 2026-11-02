<script lang="ts">
  import type { PageData } from './$types'
  import ActivationNotice from './activation-notice.svelte'
  import StyleCard from './style-card.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()

  type Item = NonNullable<PageData['corpus']>['items'][number]
  type Draft = NonNullable<PageData['drafts']>[number]
  type Match = { item: Item; distance: number }

  const PICKS_FOR_MATCHES = 3

  let pickedIds = $state<string[]>([])
  let matches = $state<Match[]>([])
  let pendingMatch = $state<Match | null>(null)
  let draftName = $state('')
  let createdDraft = $state<{ id: string; name: string } | null>(null)
  let drafts = $state<Draft[]>(data.drafts ?? [])
  let busy = $state(false)
  let error = $state('')

  // M7 tree navigation state: traversal trail (pivot ids, client-side),
  // cached similar-results per pivot, and the panel's current pivot.
  let trail = $state<string[]>([])
  let similarResults = $state<Record<string, Match[]>>({})
  let panelItemId = $state<string | null>(null)
  let similarBusy = $state(false)

  const itemsById = $derived(
    data.corpus ? new Map(data.corpus.items.map((item) => [item.id, item])) : new Map<string, Item>(),
  )
  const pickedCount = $derived(pickedIds.length)
  const canShowMatches = $derived(pickedCount >= PICKS_FOR_MATCHES && !busy)
  const canCreateDraft = $derived(pendingMatch !== null && draftName.trim().length > 0 && !busy)
  const panelItem = $derived(panelItemId !== null ? (itemsById.get(panelItemId) ?? null) : null)
  const panelResults = $derived(panelItemId !== null ? (similarResults[panelItemId] ?? []) : [])

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${path} failed (${response.status}): ${text.slice(0, 400)}`)
    }
    return JSON.parse(text) as Record<string, unknown>
  }

  function togglePick(id: string): void {
    error = ''
    matches = []
    pendingMatch = null
    createdDraft = null
    pickedIds = pickedIds.includes(id) ? pickedIds.filter((picked) => picked !== id) : [...pickedIds, id]
  }

  async function showMatches(): Promise<void> {
    busy = true
    error = ''
    try {
      const result = await post('/api/brand/selection/matches', { pickedIds })
      matches = result.matches as Match[]
      pendingMatch = null
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function useDesign(match: Match): void {
    error = ''
    createdDraft = null
    draftName = ''
    pendingMatch = match
  }

  async function createDraft(): Promise<void> {
    if (!pendingMatch) return
    busy = true
    error = ''
    try {
      const item = pendingMatch.item
      const result = await post('/api/brand/visual-sets', {
        name: draftName.trim(),
        sourceItemId: item.id,
        pickedIds,
        cssVars: item.cssVars,
        ...(item.darkCssVars === undefined ? {} : { darkCssVars: item.darkCssVars }),
      })
      createdDraft = { id: String(result.id), name: String(result.name) }
      pendingMatch = null
      const response = await fetch('/api/brand/visual-sets')
      if (!response.ok) throw new Error(`draft list refresh failed (${response.status})`)
      drafts = (await response.json()) as Draft[]
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  // --- M7 tree navigation (client state only; endpoint is a pure lookup) ---

  async function openSimilar(itemId: string): Promise<void> {
    error = ''
    similarBusy = true
    try {
      const result = await post('/api/brand/corpus/similar', { itemId })
      similarResults = { ...similarResults, [itemId]: result.similar as Match[] }
      panelItemId = itemId
      trail = trail.includes(itemId) ? trail.slice(0, trail.indexOf(itemId) + 1) : [...trail, itemId]
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      similarBusy = false
    }
  }

  function jumpToCrumb(index: number): void {
    const itemId = trail[index]
    if (itemId === undefined) return
    trail = trail.slice(0, index + 1)
    panelItemId = itemId
  }

  function resetNavigation(): void {
    trail = []
    panelItemId = null
  }
</script>

<svelte:head>
  <title>{docTitle('Brand')}</title>
</svelte:head>

{#if data.needsModuleActivation}
  <ActivationNotice />
{:else}
<div class="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8">
  <header>
    <h1 class="text-2xl font-semibold">Brand selection wizard</h1>
    <p class="text-sm text-neutral-600">
      Pick the style cards that feel right (at least {PICKS_FOR_MATCHES}), show the nearest corpus
      designs, and land one as the working draft. Every card has a “Similar →” trail into the
      precomputed k-NN, and clusters link to their nearest neighbors — pure lookups over the corpus
      index, no LLM. Activation (applying the draft) comes with publish.
    </p>
  </header>

  {#if error}
    <pre class="whitespace-pre-wrap rounded border border-red-400 bg-red-50 p-3 text-xs text-red-800">{error}</pre>
  {/if}

  {#if panelItem}
    <aside class="fixed inset-y-0 right-0 z-40 flex w-[30rem] max-w-full flex-col gap-3 overflow-y-auto border-l border-neutral-300 bg-white p-4 shadow-xl">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-lg font-medium">Similar styles</h2>
        <button
          type="button"
          class="rounded border px-2 py-1 text-sm hover:bg-neutral-100"
          onclick={resetNavigation}
        >
          Close
        </button>
      </div>
      <nav class="flex flex-wrap items-center gap-1 text-sm text-neutral-600" aria-label="Traversal path">
        {#each trail as crumbId, i (crumbId)}
          {@const crumb = itemsById.get(crumbId)}
          {#if crumb}
            {#if i > 0}<span class="text-neutral-400">→</span>{/if}
            {#if i === trail.length - 1}
              <span class="font-medium text-neutral-900">{crumb.name}</span>
            {:else}
              <button type="button" class="underline hover:text-neutral-900" onclick={() => jumpToCrumb(i)}>
                {crumb.name}
              </button>
            {/if}
          {/if}
        {/each}
      </nav>
      <p class="text-xs text-neutral-500">
        Ranked “more like this” from the precomputed corpus k-NN — click a card to pivot the trail.
      </p>
      {#if similarBusy}
        <p class="text-sm text-neutral-500">Working…</p>
      {/if}
      <div class="flex flex-wrap gap-3">
        {#each panelResults as match (match.item.id)}
          <StyleCard
            item={match.item}
            distance={match.distance}
            compact={true}
            selected={pickedIds.includes(match.item.id)}
            ontoggle={() => void openSimilar(match.item.id)}
          />
        {/each}
      </div>
    </aside>
  {/if}

  <section class="flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-medium">1 — Pick styles</h2>
      <span class="text-sm font-medium" class:text-neutral-900={pickedCount >= PICKS_FOR_MATCHES} class:text-neutral-500={pickedCount < PICKS_FOR_MATCHES}>
        Picked {pickedCount}/{PICKS_FOR_MATCHES}
      </span>
    </div>
    {#each data.corpus.clusters as cluster (cluster.id)}
      <div id={`cluster-${cluster.id}`} class="flex flex-col gap-2 scroll-mt-4">
        <div class="flex flex-wrap items-baseline gap-2">
          <h3 class="text-sm font-semibold text-neutral-700">{cluster.name}</h3>
          {#if cluster.adjacentClusters.length > 0}
            <span class="text-xs text-neutral-400">
              tunnels:
              {#each cluster.adjacentClusters as adjacent, i (adjacent.id)}
                {#if i > 0}<span class="mx-0.5">·</span>{/if}
                <a class="text-neutral-500 underline hover:text-neutral-900" href={`#cluster-${adjacent.id}`} onclick={resetNavigation}>
                  {adjacent.name}
                </a>
              {/each}
            </span>
          {/if}
        </div>
        <div class="flex flex-wrap gap-3">
          {#each cluster.memberIds as memberId (memberId)}
            {@const item = itemsById.get(memberId)}
            {#if item}
              <StyleCard
                {item}
                selected={pickedIds.includes(item.id)}
                ontoggle={() => togglePick(item.id)}
                onsimilar={() => void openSimilar(item.id)}
              />
            {/if}
          {/each}
        </div>
      </div>
    {/each}
  </section>

  <section class="flex flex-col gap-4">
    <h2 class="text-lg font-medium">2 — Matches</h2>
    <button
      type="button"
      class="self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      disabled={!canShowMatches}
      onclick={() => void showMatches()}
    >
      {busy ? 'Working…' : 'Show matches'}
    </button>
    {#if pickedCount > 0 && pickedCount < PICKS_FOR_MATCHES}
      <p class="text-sm text-neutral-500">
        Pick {PICKS_FOR_MATCHES - pickedCount} more style card{PICKS_FOR_MATCHES - pickedCount === 1 ? '' : 's'} to unlock matches.
      </p>
    {/if}
    {#if matches.length > 0}
      <div class="flex flex-wrap gap-4">
        {#each matches as match (match.item.id)}
          <div class="flex flex-col gap-2">
            <StyleCard item={match.item} distance={match.distance} />
            <button
              type="button"
              class="rounded border px-3 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50"
              disabled={busy}
              onclick={() => useDesign(match)}
            >
              Use this design
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  {#if pendingMatch}
    <section class="flex flex-col gap-3 rounded border-2 border-neutral-900 p-4">
      <h2 class="text-lg font-medium">New working draft from “{pendingMatch.item.name}”</h2>
      <div class="flex flex-col gap-2">
        <label class="text-sm font-medium" for="draft-name">Draft name</label>
        <input
          id="draft-name"
          class="w-full max-w-sm rounded border px-3 py-2 text-sm"
          type="text"
          placeholder="e.g. Kindred visual draft"
          bind:value={draftName}
        />
        <button
          type="button"
          class="self-start rounded bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={!canCreateDraft}
          onclick={() => void createDraft()}
        >
          {busy ? 'Working…' : 'Create working draft'}
        </button>
      </div>
    </section>
  {/if}

  {#if createdDraft}
    <section class="flex flex-col gap-1 rounded border border-emerald-600 bg-emerald-50 p-4">
      <h2 class="text-lg font-medium text-emerald-900">Draft created</h2>
      <p class="text-sm text-emerald-900">
        <code>{createdDraft.id}</code> — {createdDraft.name}
      </p>
      <p class="text-sm text-emerald-800">
        This is a working draft. Activation (applying it to the app and site) comes with publish.
      </p>
    </section>
  {/if}

  <section class="flex flex-col gap-2">
    <h2 class="text-lg font-medium">Working drafts</h2>
    {#if drafts.length === 0}
      <p class="text-sm text-neutral-500">No drafts yet.</p>
    {:else}
      <ul class="flex flex-col gap-1 text-sm">
        {#each drafts as draft (draft.id)}
          <li>
            <code class="text-xs">{draft.id}</code>
            — {draft.name}
            <span class="text-neutral-500">({draft.status})</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
{/if}
