<script lang="ts">
  import Clock from '@lucide/svelte/icons/clock'
  import { onMount, tick } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import {
    loadEmojiCatalog,
    searchEmoji,
    type CatalogEmoji,
    type EmojiCatalog,
  } from './emoji-catalog'
  import { readRecentEmoji, rememberRecentEmoji } from './emoji-recent'

  /**
   * The full emoji picker (Contribute 89815b8d): search by name or keyword,
   * Unicode's categories, and this browser's recently used emoji first. The
   * dataset loads on first open. Keyboard: the search is focused; ↓ enters the
   * grid, arrows move (one tab stop), Enter picks; Enter in the search picks
   * the first match; Esc closes.
   */
  let {
    label,
    onpick,
    onclose,
    load = loadEmojiCatalog,
  }: {
    /** The dialog's name, e.g. "Pick a reaction". */
    label: string
    onpick: (emoji: string) => void
    onclose?: () => void
    load?: () => Promise<EmojiCatalog>
  } = $props()

  type Section = { key: string; label: string; emoji: CatalogEmoji[] }
  const RECENT_KEY = 'recent'

  let catalog = $state<EmojiCatalog | null>(null)
  let loadError = $state<string | null>(null)
  let recent = $state<string[]>([])
  let query = $state('')
  let current = $state<string | null>(null)
  /** The grid's one tab stop: "section:index". */
  let activeId = $state<string | null>(null)
  let searchEl = $state<HTMLInputElement | null>(null)
  let listEl = $state<HTMLDivElement | null>(null)

  const byEmoji = $derived(
    new Map((catalog?.groups ?? []).flatMap((g) => g.emoji.map((e) => [e.emoji, e] as const))),
  )
  const searching = $derived(query.trim().length > 0)
  const results = $derived(catalog && searching ? searchEmoji(catalog, query) : [])
  const sections = $derived.by((): Section[] => {
    if (!catalog) return []
    if (searching) return [{ key: 'results', label: 'Search results', emoji: results }]
    const recentEmoji = recent.map((e) => byEmoji.get(e) ?? { emoji: e, label: e, tags: [] })
    return [
      ...(recentEmoji.length > 0
        ? [{ key: RECENT_KEY, label: 'Recently used', emoji: recentEmoji }]
        : []),
      ...catalog.groups,
    ]
  })
  const tabStop = $derived(activeId ?? (sections[0]?.emoji.length ? `${sections[0].key}:0` : null))

  onMount(() => {
    recent = readRecentEmoji()
    searchEl?.focus()
    load().then(
      (c) => (catalog = c),
      (err: unknown) => (loadError = err instanceof Error ? err.message : String(err)),
    )
  })

  function pick(emoji: string) {
    recent = rememberRecentEmoji(emoji)
    onpick(emoji)
  }

  function onSearchInput() {
    activeId = null
    listEl?.scrollTo({ top: 0 })
  }

  async function jumpTo(key: string) {
    query = ''
    activeId = null
    current = key
    await tick()
    const heading = listEl?.querySelector<HTMLElement>(`[data-section="${key}"]`)
    // The list is the headings' offset parent (relative).
    if (listEl && heading) listEl.scrollTop = heading.offsetTop
  }

  /** Marks the category whose section is at the top of the list. */
  function onListScroll() {
    if (!listEl || searching) return
    const top = listEl.scrollTop + 1
    let at: string | null = null
    for (const el of listEl.querySelectorAll<HTMLElement>('[data-section]')) {
      if (el.offsetTop <= top) at = el.dataset.section ?? null
    }
    current = at
  }

  const buttons = () => [
    ...(listEl?.querySelectorAll<HTMLButtonElement>('[data-testid="emoji-picker-emoji"]') ?? []),
  ]

  function focusButton(b: HTMLButtonElement | undefined) {
    if (!b) return
    activeId = b.dataset.id ?? null
    b.focus()
  }

  /** Arrow keys by position on screen, so rows stay rows across section breaks. */
  function onGridKey(e: KeyboardEvent) {
    const all = buttons()
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      focusButton(all[i + (e.key === 'ArrowRight' ? 1 : -1)])
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const from = all[i].getBoundingClientRect()
      const down = e.key === 'ArrowDown'
      const rows = all.filter((b) => {
        const r = b.getBoundingClientRect()
        return down ? r.top > from.top + 1 : r.top < from.top - 1
      })
      if (rows.length === 0) {
        if (!down) searchEl?.focus()
        return
      }
      const rowTop = down
        ? Math.min(...rows.map((b) => b.getBoundingClientRect().top))
        : Math.max(...rows.map((b) => b.getBoundingClientRect().top))
      const row = rows.filter((b) => Math.abs(b.getBoundingClientRect().top - rowTop) < 1)
      const nearest = row.reduce((best, b) =>
        Math.abs(b.getBoundingClientRect().left - from.left) <
        Math.abs(best.getBoundingClientRect().left - from.left)
          ? b
          : best,
      )
      focusButton(nearest)
    }
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const all = buttons()
      focusButton(all.find((b) => b.dataset.id === tabStop) ?? all[0])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (results[0]) pick(results[0].emoji)
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onclose?.()
    }
  }
</script>

<div
  class="flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
  role="dialog"
  aria-label={label}
  tabindex="-1"
  data-testid="emoji-picker"
  onkeydown={onKey}
>
  <div class="p-2 pb-1">
    <input
      bind:this={searchEl}
      bind:value={query}
      type="search"
      class="h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      placeholder="Search emoji"
      aria-label="Search emoji"
      autocomplete="off"
      spellcheck="false"
      data-testid="emoji-picker-search"
      oninput={onSearchInput}
      onkeydown={onSearchKey}
    />
  </div>

  {#if loadError}
    <ErrorNotice
      class="items-center px-3 py-6 text-center"
      error="Couldn’t load the emoji list: {loadError}"
      attempted="Loading the emoji list for the emoji picker"
    />
  {:else if !catalog}
    <p class="px-3 py-6 text-center text-sm text-muted-foreground" role="status">Loading emoji…</p>
  {:else}
    <nav
      class="flex items-center gap-px border-b border-border px-1.5 pb-1"
      aria-label="Emoji categories"
    >
      {#if recent.length > 0}
        {@render categoryButton(RECENT_KEY, 'Recently used', null)}
      {/if}
      {#each catalog.groups as g (g.key)}
        {@render categoryButton(g.key, g.label, g.emoji[0]?.emoji ?? null)}
      {/each}
    </nav>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={listEl}
      class="relative h-64 overflow-y-auto overscroll-contain px-1.5 pb-2"
      onscroll={onListScroll}
      onkeydown={onGridKey}
    >
      {#if searching && results.length === 0}
        <p class="px-2 py-6 text-center text-sm text-muted-foreground">
          No emoji match “{query.trim()}”.
        </p>
      {/if}
      {#each sections as s (s.key)}
        {#if s.emoji.length > 0}
          <h3
            id="emoji-section-{s.key}"
            class="px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground"
            data-section={s.key}
          >
            {s.label}
          </h3>
          <div
            class="grid grid-cols-8 gap-0.5"
            role="group"
            aria-labelledby="emoji-section-{s.key}"
          >
            {#each s.emoji as e, i (e.emoji)}
              {@const id = `${s.key}:${i}`}
              <button
                type="button"
                class="grid aspect-square place-items-center rounded-md text-xl leading-none outline-none hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
                tabindex={id === tabStop ? 0 : -1}
                aria-label={e.label}
                title={e.label}
                data-testid="emoji-picker-emoji"
                data-emoji={e.emoji}
                data-id={id}
                onfocus={() => (activeId = id)}
                onclick={() => pick(e.emoji)}>{e.emoji}</button
              >
            {/each}
          </div>
        {/if}
      {/each}
    </div>
    <p class="sr-only" aria-live="polite">{searching ? `${results.length} emoji found` : ''}</p>
  {/if}
</div>

{#snippet categoryButton(key: string, name: string, icon: string | null)}
  <button
    type="button"
    class={[
      'grid h-8 min-w-0 flex-1 place-items-center rounded-md text-base leading-none hover:bg-foreground/[0.06]',
      current === key && !searching ? 'bg-foreground/[0.06]' : 'opacity-70 hover:opacity-100',
    ]}
    aria-label={name}
    title={name}
    aria-current={current === key && !searching ? 'true' : undefined}
    onclick={() => jumpTo(key)}
  >
    {#if icon}<span aria-hidden="true">{icon}</span>{:else}<Clock
        class="size-4 text-muted-foreground"
        aria-hidden="true"
      />{/if}
  </button>
{/snippet}
