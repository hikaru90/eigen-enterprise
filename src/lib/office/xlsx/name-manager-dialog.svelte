<script lang="ts">
  import type { NameOp, NameView } from './names'
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Name Manager dialog: lists defined names (workbook-wide and sheet-scoped,
   * built-in names shown read-only), and adds, renames/edits or deletes them.
   */
  let {
    names,
    sheets,
    defaultRefersTo,
    onop,
    onclose,
  }: {
    names: NameView[]
    sheets: string[]
    defaultRefersTo: string
    onop: (op: NameOp) => Promise<string | null>
    onclose: () => void
  } = $props()

  let selected = $state<{ name: string; scope: string | null } | null>(null)
  let name = $state('')
  let scope = $state('')
  let refersTo = $state(untrack(() => defaultRefersTo))
  let comment = $state('')
  let error = $state<string | null>(null)

  function reset() {
    selected = null
    name = ''
    scope = ''
    refersTo = defaultRefersTo
    comment = ''
    error = null
  }

  function pick(n: NameView) {
    if (n.builtIn) return
    selected = { name: n.name, scope: n.scope }
    name = n.name
    scope = n.scope ?? ''
    refersTo = n.refersTo
    comment = n.comment ?? ''
    error = null
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    error = null
    const op: NameOp = selected
      ? {
          op: 'name_update',
          name: selected.name,
          scope: selected.scope,
          newName: name,
          refersTo,
          comment: comment.trim() || null,
        }
      : {
          op: 'name_add',
          name,
          scope: scope || null,
          refersTo,
          comment: comment.trim() || null,
        }
    const err = await onop(op)
    if (err) error = err
    else reset()
  }

  async function remove() {
    if (!selected) return
    error = null
    const err = await onop({ op: 'name_delete', name: selected.name, scope: selected.scope })
    if (err) error = err
    else reset()
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
  <Dialog.Content class="max-w-lg" data-testid="xlsx-names-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.drive_sheet_names_title()}</Dialog.Title>
    </Dialog.Header>
    {#if error}
      <p
        class="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        role="alert"
        data-testid="xlsx-names-error"
      >
        {error}
      </p>
    {/if}

    {#if names.length === 0}
      <p class="text-xs text-muted-foreground" data-testid="xlsx-names-empty">
        {m.drive_sheet_names_empty()}
      </p>
    {:else}
      <div class="max-h-44 overflow-y-auto rounded border border-border">
        <table class="w-full text-left text-xs" data-testid="xlsx-names-list">
          <thead class="border-b bg-muted/40 text-muted-foreground">
            <tr>
              <th class="px-2 py-1.5 font-medium">{m.drive_sheet_names_name()}</th>
              <th class="px-2 py-1.5 font-medium">{m.drive_sheet_names_scope()}</th>
              <th class="px-2 py-1.5 font-medium">{m.drive_sheet_names_refers()}</th>
            </tr>
          </thead>
          <tbody>
            {#each names as n (`${n.scope ?? ''}::${n.name}`)}
              {@const isSel = selected?.name === n.name && selected?.scope === n.scope}
              <tr
                class="border-b last:border-b-0 {n.builtIn
                  ? 'opacity-60'
                  : 'cursor-pointer hover:bg-muted/50'} {isSel ? 'bg-primary/10' : ''}"
                onclick={() => pick(n)}
                data-testid="xlsx-name-row"
              >
                <td class="px-2 py-1.5 font-mono">
                  {n.name}
                  {#if n.builtIn}<span class="ml-1 rounded bg-muted px-1 text-[10px]"
                      >{m.drive_sheet_names_builtin()}</span
                    >{/if}
                </td>
                <td class="px-2 py-1.5">{n.scope ?? m.drive_sheet_names_workbook()}</td>
                <td class="px-2 py-1.5 font-mono truncate max-w-48">{n.refersTo}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <form class="flex flex-col gap-2.5 border-t pt-3 text-xs" onsubmit={submit}>
      <div class="grid grid-cols-2 gap-2.5">
        <label class="flex flex-col gap-1">
          <span class="text-muted-foreground">{m.drive_sheet_names_name()}</span>
          <input class={field} bind:value={name} data-testid="xlsx-name-input" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-muted-foreground">{m.drive_sheet_names_scope()}</span>
          <select
            class={field}
            bind:value={scope}
            disabled={selected !== null}
            data-testid="xlsx-name-scope"
          >
            <option value="">{m.drive_sheet_names_workbook()}</option>
            {#each sheets as s (s)}<option value={s}>{s}</option>{/each}
          </select>
        </label>
      </div>
      <label class="flex flex-col gap-1">
        <span class="text-muted-foreground">{m.drive_sheet_names_refers()}</span>
        <input class={field} bind:value={refersTo} data-testid="xlsx-name-refers" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-muted-foreground">{m.drive_sheet_names_comment()}</span>
        <input class={field} bind:value={comment} data-testid="xlsx-name-comment" />
      </label>
      <Dialog.Footer class="pt-1">
        {#if selected}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            class="mr-auto"
            onclick={() => void remove()}
            data-testid="xlsx-name-delete"
          >
            {m.drive_sheet_names_delete()}
          </Button>
          <Button type="button" variant="ghost" size="sm" onclick={reset}
            >{m.drive_sheet_names_new_mode()}</Button
          >
        {/if}
        <Button type="button" variant="outline" onclick={onclose} data-testid="xlsx-names-close"
          >{m.drive_sheet_cf_close()}</Button
        >
        <Button type="submit" data-testid="xlsx-name-save">
          {selected ? m.drive_sheet_names_save() : m.drive_sheet_names_add()}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
