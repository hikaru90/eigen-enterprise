<script lang="ts">
  import type { DriveFolderOption } from './composer'
  import Folder from '@lucide/svelte/icons/folder'
  import { onDestroy, onMount } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import type { ShownError } from '$lib/errors/agent-report'
  import { MessagesRequestError, shownFailure } from './view'

  async function defaultLoad(
    query: string,
    signal?: AbortSignal,
  ): Promise<DriveFolderOption[]> {
    const q = query.trim()
    const path = q
      ? `/api/messages/drive-folders?q=${encodeURIComponent(q)}`
      : '/api/messages/drive-folders'
    const res = await fetch(path, { signal })
    const body = (await res.json().catch(() => ({}))) as {
      folders?: DriveFolderOption[]
    }
    if (!res.ok) throw new MessagesRequestError(body, `request failed (${res.status})`)
    return body.folders ?? []
  }

  let {
    label = 'Link a Drive folder',
    onpick,
    onclose,
    load = defaultLoad,
  }: {
    label?: string
    onpick: (folder: DriveFolderOption) => void
    onclose?: () => void
    load?: (query: string, signal?: AbortSignal) => Promise<DriveFolderOption[]>
  } = $props()

  const uid = $props.id()
  const listId = `${uid}-drive-folders`

  let query = $state('')
  let folders = $state<DriveFolderOption[]>([])
  let initialFolders = $state<DriveFolderOption[] | null>(null)
  let loading = $state(true)
  let error = $state<ShownError | null>(null)
  let activeIndex = $state(0)
  let searchEl = $state<HTMLInputElement | null>(null)

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | null = null
  let requestSeq = 0

  function isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === 'AbortError'
  }

  async function runLoad(q: string) {
    const seq = ++requestSeq
    controller?.abort()
    const nextController = new AbortController()
    controller = nextController
    loading = true
    error = null
    try {
      const list = await load(q, nextController.signal)
      if (seq !== requestSeq) return
      if (!q) initialFolders = list
      folders = list
      activeIndex = 0
    } catch (err) {
      if (seq !== requestSeq || isAbortError(err)) return
      error = shownFailure(err)
    } finally {
      if (seq === requestSeq) loading = false
    }
  }

  onMount(() => {
    searchEl?.focus()
    void runLoad('')
  })

  onDestroy(() => {
    clearTimeout(debounceTimer)
    controller?.abort()
  })

  function onSearchInput() {
    activeIndex = 0
    clearTimeout(debounceTimer)
    controller?.abort()
    const q = query.trim()
    if (!q && initialFolders !== null) {
      folders = initialFolders
      error = null
      loading = false
      return
    }
    loading = true
    debounceTimer = setTimeout(() => {
      void runLoad(q)
    }, 120)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onclose?.()
      return
    }
    if (e.key === 'ArrowDown' && folders.length > 0) {
      e.preventDefault()
      activeIndex = (activeIndex + 1) % folders.length
      return
    }
    if (e.key === 'ArrowUp' && folders.length > 0) {
      e.preventDefault()
      activeIndex = (activeIndex - 1 + folders.length) % folders.length
      return
    }
    if (e.key === 'Enter' && !e.isComposing && folders.length > 0) {
      e.preventDefault()
      const picked = folders[Math.min(activeIndex, folders.length - 1)]
      if (picked) onpick(picked)
    }
  }
</script>

<div
  class="flex w-80 max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
  role="dialog"
  aria-label={label}
  tabindex="-1"
  data-testid="drive-folder-picker"
  onkeydown={onKey}
>
  <div class="border-b border-border p-2">
    <input
      bind:this={searchEl}
      bind:value={query}
      type="search"
      role="searchbox"
      class="h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      placeholder="Search Drive folders"
      aria-label="Search Drive folders"
      aria-controls={listId}
      autocomplete="off"
      spellcheck="false"
      data-testid="drive-folder-picker-search"
      oninput={onSearchInput}
    />
  </div>

  {#if error}
    <ErrorNotice
      class="items-center px-3 py-5 text-center text-xs"
      error={error.error}
      agent={error.agent}
      attempted="Loading Drive folders"
    />
  {:else if loading && folders.length === 0}
    <p class="px-3 py-5 text-center text-sm text-muted-foreground" role="status">
      Loading folders…
    </p>
  {:else if folders.length === 0}
    <p class="px-3 py-5 text-center text-sm text-muted-foreground">
      {query.trim()
        ? `No Drive folders match “${query.trim()}”.`
        : 'No Drive folders available.'}
    </p>
  {:else}
    <ul
      id={listId}
      role="listbox"
      aria-label="Drive folders"
      class="max-h-64 overflow-y-auto overscroll-contain p-1"
    >
      {#each folders as f, i (f.id)}
        <li role="presentation">
          <button
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            class={[
              'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none',
              i === activeIndex
                ? 'bg-foreground/[0.08] text-foreground'
                : 'hover:bg-foreground/[0.04]',
            ]}
            data-testid="drive-folder-option"
            data-id={f.id}
            onmousemove={() => (activeIndex = i)}
            onclick={() => onpick(f)}
          >
            <Folder class="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{f.name}</span>
              <span class="block truncate text-xs text-muted-foreground">{f.pathLabel}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
