<script lang="ts">
  import type {
    CellProtection,
    ProtectionOp,
    SheetProtection,
    WorkbookProtection,
  } from './protection'
  import { untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { m } from '$lib/paraglide/messages.js'
  import { SHEET_ALLOW, type SheetAllow } from './rules-choices'

  /**
   * Sheet & workbook protection dialog: protects/unprotects the active sheet
   * (with optional SHA-512 password and permission flags), locks/unlocks cells
   * in the selection, and protects/unprotects workbook structure.
   */
  let {
    sheet,
    selection,
    sheetProt,
    wbProt,
    cellProt,
    onop,
    onclose,
  }: {
    sheet: string
    selection: string
    sheetProt: SheetProtection | null
    wbProt: WorkbookProtection | null
    cellProt: CellProtection
    onop: (op: ProtectionOp) => Promise<string | null>
    onclose: () => void
  } = $props()

  let sheetPw = $state('')
  let wbPw = $state('')
  let locked = $state(untrack(() => cellProt.locked))
  let hidden = $state(untrack(() => cellProt.hidden))
  const allowed = new SvelteSet<SheetAllow>(['selectLockedCells', 'selectUnlockedCells'])
  let error = $state<string | null>(null)

  const allowLabel = (k: SheetAllow): string =>
    ({
      selectLockedCells: m.drive_sheet_allow_selectLockedCells(),
      selectUnlockedCells: m.drive_sheet_allow_selectUnlockedCells(),
      formatCells: m.drive_sheet_allow_formatCells(),
      formatColumns: m.drive_sheet_allow_formatColumns(),
      formatRows: m.drive_sheet_allow_formatRows(),
      insertColumns: m.drive_sheet_allow_insertColumns(),
      insertRows: m.drive_sheet_allow_insertRows(),
      insertHyperlinks: m.drive_sheet_allow_insertHyperlinks(),
      deleteColumns: m.drive_sheet_allow_deleteColumns(),
      deleteRows: m.drive_sheet_allow_deleteRows(),
      sort: m.drive_sheet_allow_sort(),
      autoFilter: m.drive_sheet_allow_autoFilter(),
      pivotTables: m.drive_sheet_allow_pivotTables(),
      objects: m.drive_sheet_allow_objects(),
      scenarios: m.drive_sheet_allow_scenarios(),
    })[k]

  function toggleAllow(k: SheetAllow, on: boolean) {
    if (on) allowed.add(k)
    else allowed.delete(k)
  }

  async function run(op: ProtectionOp, clearSheetPw = false, clearWbPw = false) {
    error = null
    const err = await onop(op)
    if (err) {
      error = err
      return
    }
    if (clearSheetPw) sheetPw = ''
    if (clearWbPw) wbPw = ''
  }

  function protectSheet() {
    const allow = Object.fromEntries(SHEET_ALLOW.map((k) => [k, allowed.has(k)])) as Record<
      SheetAllow,
      boolean
    >
    void run({ op: 'protect_sheet', sheet, password: sheetPw || null, allow }, true, false)
  }

  const field =
    'h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground'
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) onclose()
  }}
>
  <Dialog.Content class="max-w-lg" data-testid="xlsx-protect-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.drive_sheet_protect_title()}</Dialog.Title>
    </Dialog.Header>
    {#if error}
      <p
        class="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        role="alert"
        data-testid="xlsx-protect-error"
      >
        {error}
      </p>
    {/if}

    <div class="flex flex-col gap-3 text-xs">
      <!-- Sheet protection -->
      <section class="flex flex-col gap-2 rounded border border-border p-2.5">
        <div class="flex items-center justify-between">
          <h3 class="font-medium text-sm">{m.drive_sheet_protect_sheet_heading({ sheet })}</h3>
          <span class="text-muted-foreground" data-testid="xlsx-protect-sheet-status">
            {sheetProt ? m.drive_sheet_protect_status_on() : m.drive_sheet_protect_status_off()}
          </span>
        </div>
        {#if !sheetProt}
          <input
            type="password"
            class={field}
            bind:value={sheetPw}
            placeholder={m.drive_sheet_protect_password()}
            aria-label={m.drive_sheet_protect_password()}
            data-testid="xlsx-protect-sheet-pw"
          />
          <p class="text-muted-foreground">{m.drive_sheet_protect_allow()}</p>
          <div
            class="grid max-h-36 grid-cols-2 gap-1 overflow-y-auto rounded border border-border/60 p-2"
          >
            {#each SHEET_ALLOW as k (k)}
              <label class="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={allowed.has(k)}
                  onchange={(e) => toggleAllow(k, e.currentTarget.checked)}
                  data-testid="xlsx-allow-{k}"
                />
                {allowLabel(k)}
              </label>
            {/each}
          </div>
          <div class="flex justify-end">
            <Button size="sm" onclick={protectSheet} data-testid="xlsx-protect-sheet-btn">
              {m.drive_sheet_protect_do_sheet()}
            </Button>
          </div>
        {:else}
          {#if sheetProt.hasPassword}
            <input
              type="password"
              class={field}
              bind:value={sheetPw}
              placeholder={m.drive_sheet_protect_password_enter()}
              aria-label={m.drive_sheet_protect_password_enter()}
              data-testid="xlsx-unprotect-sheet-pw"
            />
          {/if}
          <div class="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onclick={() =>
                void run({ op: 'unprotect_sheet', sheet, password: sheetPw || null }, true, false)}
              data-testid="xlsx-unprotect-sheet-btn"
            >
              {m.drive_sheet_unprotect_sheet()}
            </Button>
          </div>
        {/if}
      </section>

      <!-- Selection cell lock/hidden -->
      <section class="flex flex-col gap-2 rounded border border-border p-2.5">
        <h3 class="font-medium text-sm">
          {m.drive_sheet_protect_cells_heading({ range: selection })}
        </h3>
        <div class="flex items-center justify-between gap-3">
          <div class="flex gap-4">
            <label class="flex items-center gap-1.5">
              <input type="checkbox" bind:checked={locked} data-testid="xlsx-cell-locked" />
              {m.drive_sheet_protect_locked()}
            </label>
            <label class="flex items-center gap-1.5">
              <input type="checkbox" bind:checked={hidden} data-testid="xlsx-cell-hidden" />
              {m.drive_sheet_protect_hidden()}
            </label>
          </div>
          <Button
            size="sm"
            variant="outline"
            onclick={() =>
              void run({ op: 'set_cell_protection', sheet, range: selection, locked, hidden })}
            data-testid="xlsx-cell-prot-apply"
          >
            {m.drive_sheet_protect_apply_cells()}
          </Button>
        </div>
      </section>

      <!-- Workbook structure protection -->
      <section class="flex flex-col gap-2 rounded border border-border p-2.5">
        <div class="flex items-center justify-between">
          <h3 class="font-medium text-sm">{m.drive_sheet_protect_wb_heading()}</h3>
          <span class="text-muted-foreground" data-testid="xlsx-protect-wb-status">
            {wbProt?.structure
              ? m.drive_sheet_protect_status_on()
              : m.drive_sheet_protect_status_off()}
          </span>
        </div>
        {#if !wbProt?.structure}
          <div class="flex gap-2">
            <input
              type="password"
              class={field}
              bind:value={wbPw}
              placeholder={m.drive_sheet_protect_password()}
              aria-label={m.drive_sheet_protect_password()}
              data-testid="xlsx-protect-wb-pw"
            />
            <Button
              size="sm"
              onclick={() =>
                void run({ op: 'protect_workbook', password: wbPw || null }, false, true)}
              data-testid="xlsx-protect-wb-btn"
            >
              {m.drive_sheet_protect_do_wb()}
            </Button>
          </div>
        {:else}
          <div class="flex gap-2">
            {#if wbProt.hasPassword}
              <input
                type="password"
                class={field}
                bind:value={wbPw}
                placeholder={m.drive_sheet_protect_password_enter()}
                aria-label={m.drive_sheet_protect_password_enter()}
                data-testid="xlsx-unprotect-wb-pw"
              />
            {/if}
            <Button
              size="sm"
              variant="outline"
              onclick={() =>
                void run({ op: 'unprotect_workbook', password: wbPw || null }, false, true)}
              data-testid="xlsx-unprotect-wb-btn"
            >
              {m.drive_sheet_unprotect_wb()}
            </Button>
          </div>
        {/if}
      </section>
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={onclose} data-testid="xlsx-protect-close"
        >{m.drive_sheet_cf_close()}</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
