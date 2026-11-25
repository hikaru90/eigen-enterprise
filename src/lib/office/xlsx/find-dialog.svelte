<script lang="ts">
  import type { FindHit } from './find'
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Excel's Find & Replace (`Ctrl+F` / `Ctrl+H`) and Go To (`F5`) dialog.
   * Controlled explicitly via event callbacks (`onfind`, `onreplace`, `ongoto`, `onclose`).
   */
  let {
    mode: initialMode,
    editable,
    namedTargets,
    hits,
    hitIndex,
    lastQuery,
    onsearch,
    onnavigatehit,
    onreplaceone,
    onreplaceall,
    ongoto,
    onclose,
  }: {
    mode: 'find' | 'replace' | 'goto'
    editable: boolean
    namedTargets: Array<{ name: string; label: string }>
    hits: FindHit[]
    hitIndex: number
    lastQuery: string
    onsearch: (opts: {
      query: string
      scope: 'sheet' | 'workbook'
      lookIn: 'formulas' | 'values'
      matchCase: boolean
      wholeCell: boolean
    }) => void
    onnavigatehit: (delta: 1 | -1) => void
    onreplaceone: (opts: {
      find: string
      replace: string
      scope: 'sheet' | 'workbook'
      matchCase: boolean
      wholeCell: boolean
    }) => void
    onreplaceall: (opts: {
      find: string
      replace: string
      scope: 'sheet' | 'workbook'
      matchCase: boolean
      wholeCell: boolean
    }) => void
    ongoto: (target: string) => string | null
    onclose: () => void
  } = $props()

  let tab = $state<'find' | 'replace' | 'goto'>(untrack(() => initialMode))
  let query = $state(untrack(() => lastQuery))
  let replaceWith = $state('')
  let scope = $state<'sheet' | 'workbook'>('sheet')
  let lookIn = $state<'formulas' | 'values'>('formulas')
  let matchCase = $state(false)
  let wholeCell = $state(false)
  let gotoInput = $state('')
  let gotoError = $state<string | null>(null)
  let searched = $state(untrack(() => lastQuery !== ''))

  function submitSearch() {
    if (!query.trim()) return
    searched = true
    onsearch({ query, scope, lookIn, matchCase, wholeCell })
  }

  function nextHit() {
    if (!query) return
    if (!searched || query !== lastQuery) {
      submitSearch()
    } else {
      onnavigatehit(1)
    }
  }

  function prevHit() {
    if (!query) return
    if (!searched || query !== lastQuery) {
      submitSearch()
    } else {
      onnavigatehit(-1)
    }
  }

  function submitGoto() {
    const err = ongoto(gotoInput)
    gotoError = err
    if (!err) onclose()
  }

  const inputCls =
    'h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm focus:ring-1 focus:ring-ring focus:outline-none'
  const selectCls = 'h-8 rounded-md border border-input bg-background px-2 text-sm'
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) onclose()
  }}
>
  <Dialog.Content class="max-w-md" data-testid="xlsx-find-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.drive_sheet_find_replace()}</Dialog.Title>
    </Dialog.Header>

    <div class="flex gap-1 border-b border-border pb-2" role="tablist">
      <Button
        size="sm"
        variant={tab === 'find' ? 'secondary' : 'ghost'}
        onclick={() => (tab = 'find')}
        data-testid="xlsx-find-tab-find"
      >
        {m.drive_sheet_find_tab()}
      </Button>
      {#if editable}
        <Button
          size="sm"
          variant={tab === 'replace' ? 'secondary' : 'ghost'}
          onclick={() => {
            tab = 'replace'
            lookIn = 'formulas'
          }}
          data-testid="xlsx-find-tab-replace"
        >
          {m.drive_sheet_replace_tab()}
        </Button>
      {/if}
      <Button
        size="sm"
        variant={tab === 'goto' ? 'secondary' : 'ghost'}
        onclick={() => (tab = 'goto')}
        data-testid="xlsx-find-tab-goto"
      >
        {m.drive_sheet_goto_tab()}
      </Button>
    </div>

    {#if tab === 'goto'}
      <form
        class="flex flex-col gap-3"
        onsubmit={(e) => {
          e.preventDefault()
          submitGoto()
        }}
      >
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-muted-foreground">{m.drive_sheet_goto_ref()}</span>
          <input
            type="text"
            class={inputCls}
            bind:value={gotoInput}
            placeholder="B12, Sheet2!A1:C5"
            data-testid="xlsx-goto-input"
          />
        </label>
        {#if namedTargets.length > 0}
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">{m.drive_sheet_goto_names()}</span>
            <ul class="max-h-36 overflow-y-auto rounded-md border border-border p-1 text-xs">
              {#each namedTargets as item (item.name)}
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-accent"
                    onclick={() => {
                      const err = ongoto(item.name)
                      gotoError = err
                      if (!err) onclose()
                    }}
                  >
                    <span class="font-medium">{item.name}</span>
                    <span class="font-mono text-muted-foreground">{item.label}</span>
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        {#if gotoError}
          <p class="text-xs text-destructive" role="alert">{gotoError}</p>
        {/if}
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={onclose}>{m.drive_sheet_cancel()}</Button
          >
          <Button type="submit" data-testid="xlsx-goto-submit">{m.drive_sheet_goto_go()}</Button>
        </Dialog.Footer>
      </form>
    {:else}
      <form
        class="flex flex-col gap-3"
        onsubmit={(e) => {
          e.preventDefault()
          nextHit()
        }}
      >
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-muted-foreground">{m.drive_sheet_find_label()}</span>
          <input
            type="text"
            class={inputCls}
            bind:value={query}
            oninput={() => (searched = false)}
            data-testid="xlsx-find-input"
          />
        </label>

        {#if tab === 'replace'}
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-muted-foreground">{m.drive_sheet_replace_label()}</span>
            <input
              type="text"
              class={inputCls}
              bind:value={replaceWith}
              data-testid="xlsx-replace-input"
            />
          </label>
        {/if}

        <div class="grid grid-cols-2 gap-2 text-sm">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">{m.drive_sheet_find_scope()}</span>
            <select class={selectCls} bind:value={scope} onchange={() => (searched = false)}>
              <option value="sheet">{m.drive_sheet_find_sheet()}</option>
              <option value="workbook">{m.drive_sheet_find_workbook()}</option>
            </select>
          </label>
          {#if tab === 'find'}
            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">{m.drive_sheet_find_look_in()}</span>
              <select class={selectCls} bind:value={lookIn} onchange={() => (searched = false)}>
                <option value="formulas">{m.drive_sheet_find_formulas()}</option>
                <option value="values">{m.drive_sheet_find_values()}</option>
              </select>
            </label>
          {/if}
        </div>

        <div class="flex flex-wrap gap-4 text-sm">
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              class="accent-primary"
              bind:checked={matchCase}
              onchange={() => (searched = false)}
            />
            {m.drive_sheet_find_match_case()}
          </label>
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              class="accent-primary"
              bind:checked={wholeCell}
              onchange={() => (searched = false)}
            />
            {m.drive_sheet_find_whole_cell()}
          </label>
        </div>

        <div class="min-h-4 text-xs text-muted-foreground" data-testid="xlsx-find-status">
          {#if searched}
            {hits.length > 0
              ? m.drive_sheet_find_count({ index: hitIndex + 1, total: hits.length })
              : m.drive_sheet_find_none()}
          {/if}
        </div>

        <Dialog.Footer class="flex-wrap gap-1.5">
          {#if tab === 'replace'}
            <Button
              type="button"
              variant="outline"
              disabled={!query}
              onclick={() => {
                searched = true
                onreplaceone({ find: query, replace: replaceWith, scope, matchCase, wholeCell })
              }}
              data-testid="xlsx-replace-one"
            >
              {m.drive_sheet_replace_one()}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!query}
              onclick={() => {
                searched = true
                onreplaceall({ find: query, replace: replaceWith, scope, matchCase, wholeCell })
              }}
              data-testid="xlsx-replace-all"
            >
              {m.drive_sheet_replace_all()}
            </Button>
          {/if}
          <Button
            type="button"
            variant="outline"
            disabled={!query}
            onclick={prevHit}
            data-testid="xlsx-find-prev"
          >
            {m.drive_sheet_find_prev()}
          </Button>
          <Button type="submit" disabled={!query} data-testid="xlsx-find-next">
            {m.drive_sheet_find_next()}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
