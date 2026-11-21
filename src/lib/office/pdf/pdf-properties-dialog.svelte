<script lang="ts">
  import type { PdfProperties, PropertiesPatch } from './properties'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import DictationField from '$lib/voice/dictation-field.svelte'

  /**
   * The PDF's document properties (P3): title, author, subject and keywords
   * to edit (written to the document information and its XMP metadata on
   * Save), and what the file says about where it came from, read-only.
   */
  let {
    properties,
    canStage,
    onapply,
    onclose,
  }: {
    properties: PdfProperties
    canStage: boolean
    onapply: (patch: PropertiesPatch) => void
    onclose: () => void
  } = $props()

  let open = $state(true)
  // A form over a snapshot: the dialog is mounted fresh each time it opens.
  // svelte-ignore state_referenced_locally
  let draft = $state({
    title: properties.title,
    author: properties.author,
    subject: properties.subject,
    keywords: properties.keywords,
  })

  const fields = [
    { key: 'title', label: 'Title' },
    { key: 'author', label: 'Author' },
    { key: 'subject', label: 'Subject' },
    { key: 'keywords', label: 'Keywords' },
  ] as const
  /** Each field's input, for dictation. */
  const propEls = $state<Partial<Record<(typeof fields)[number]['key'], HTMLInputElement>>>({})

  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'

  function apply(event: SubmitEvent) {
    event.preventDefault()
    const patch: PropertiesPatch = {}
    for (const { key } of fields) if (draft[key] !== properties[key]) patch[key] = draft[key]
    if (Object.keys(patch).length) onapply(patch)
    open = false
    onclose()
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(o) => {
    if (!o) onclose()
  }}
>
  <Dialog.Content class="max-w-md" data-testid="pdf-properties">
    <Dialog.Header>
      <Dialog.Title>Document properties</Dialog.Title>
      <Dialog.Description>
        Saved with the other changes, into the file’s document information and its XMP metadata.
      </Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-3" onsubmit={apply}>
      {#each fields as f (f.key)}
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-muted-foreground">{f.label}</span>
          <DictationField field={propEls[f.key] ?? null} kind="input" disabled={!canStage} testid={`pdf-prop-${f.key}-voice`}>
            <input
              bind:this={propEls[f.key]}
              aria-label={f.label}
              class="h-8 w-full rounded-md border bg-background pr-9 pl-2 text-sm"
              bind:value={draft[f.key]}
              disabled={!canStage}
              data-testid={`pdf-prop-${f.key}`}
            />
          </DictationField>
        </label>
      {/each}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <dt>Made with</dt>
        <dd>{properties.creator || '—'}</dd>
        <dt>PDF written by</dt>
        <dd>{properties.producer || '—'}</dd>
        <dt>Created</dt>
        <dd>{date(properties.created)}</dd>
        <dt>Changed</dt>
        <dd>{date(properties.modified)}</dd>
      </dl>
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => {
            open = false
            onclose()
          }}>Cancel</Button
        >
        <Button type="submit" disabled={!canStage} data-testid="pdf-prop-apply">Apply</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
