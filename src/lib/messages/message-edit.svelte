<script lang="ts">
  import { Button } from '$lib/components/ui/button'

  /** Editing one message in place: Enter saves, Esc cancels. Seeded once from the message body. */
  let { body, onsave, oncancel }: { body: string; onsave: (body: string) => void; oncancel: () => void } = $props()

  // svelte-ignore state_referenced_locally
  let draft = $state(body)

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      oncancel()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      onsave(draft)
    }
  }
</script>

<div class="mt-1 flex flex-col gap-1.5" data-testid="messages-edit">
  <!-- svelte-ignore a11y_autofocus -->
  <textarea
    bind:value={draft}
    rows="2"
    autofocus
    class="field-sizing-content max-h-60 min-h-16 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
    aria-label="Edit message"
    data-testid="messages-edit-input"
    onkeydown={onKey}
  ></textarea>
  <div class="flex items-center gap-2">
    <Button size="sm" variant="outline" onclick={oncancel}>Cancel</Button>
    <Button size="sm" onclick={() => onsave(draft)} data-testid="messages-edit-save">Save</Button>
    <span class="text-[11px] text-muted-foreground">Enter to save · Esc to cancel</span>
  </div>
</div>
