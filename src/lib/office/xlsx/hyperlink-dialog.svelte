<script lang="ts">
  import type { HyperlinkOp, HyperlinkView } from './hyperlinks'
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Hyperlink editor dialog: adds, updates or removes an external URL,
   * mailto or in-workbook link on the selected cell/range.
   */
  let {
    sheet,
    range,
    current,
    displayText,
    onop,
    onclose,
  }: {
    sheet: string
    range: string
    current: HyperlinkView | null
    displayText: string
    onop: (op: HyperlinkOp) => Promise<string | null>
    onclose: () => void
  } = $props()

  let target = $state(
    untrack(() =>
      current
        ? current.target.kind === 'url'
          ? current.target.url
          : `#${current.target.location}`
        : '',
    ),
  )
  let text = $state(untrack(() => current?.display ?? displayText))
  let tooltip = $state(untrack(() => current?.tooltip ?? ''))
  let error = $state<string | null>(null)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    error = null
    const err = await onop({
      op: 'hyperlink_set',
      sheet,
      range,
      target,
      tooltip: tooltip.trim() || null,
      text: text === '' ? null : text,
    })
    if (err) error = err
    else onclose()
  }

  async function remove() {
    error = null
    const err = await onop({ op: 'hyperlink_remove', sheet, range })
    if (err) error = err
    else onclose()
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
  <Dialog.Content class="max-w-md" data-testid="xlsx-link-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.drive_sheet_link_title({ ref: range })}</Dialog.Title>
    </Dialog.Header>
    {#if error}
      <p
        class="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        role="alert"
        data-testid="xlsx-link-error"
      >
        {error}
      </p>
    {/if}
    <form class="flex flex-col gap-3 text-sm" onsubmit={submit}>
      <label class="flex flex-col gap-1 text-xs">
        <span class="text-muted-foreground">{m.drive_sheet_link_target()}</span>
        <input
          class={field}
          bind:value={target}
          placeholder="https://example.com"
          data-testid="xlsx-link-target"
        />
      </label>
      <label class="flex flex-col gap-1 text-xs">
        <span class="text-muted-foreground">{m.drive_sheet_link_text()}</span>
        <input class={field} bind:value={text} data-testid="xlsx-link-text" />
      </label>
      <label class="flex flex-col gap-1 text-xs">
        <span class="text-muted-foreground">{m.drive_sheet_link_tooltip()}</span>
        <input class={field} bind:value={tooltip} data-testid="xlsx-link-tooltip" />
      </label>
      <Dialog.Footer>
        {#if current}
          <Button
            type="button"
            variant="ghost"
            class="mr-auto text-destructive"
            onclick={() => void remove()}
            data-testid="xlsx-link-remove"
          >
            {m.drive_sheet_link_remove()}
          </Button>
        {/if}
        <Button type="button" variant="outline" onclick={onclose}>{m.drive_sheet_cancel()}</Button>
        <Button type="submit" data-testid="xlsx-link-save">{m.drive_sheet_link_save()}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
