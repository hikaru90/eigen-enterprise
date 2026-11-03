<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  /** Asks for one name (new folder, new document, rename). */
  let {
    title,
    label,
    initial,
    submit,
    onclose,
  }: { title: string; label: string; initial: string; submit: (name: string) => Promise<void>; onclose: () => void } = $props()

  let open = $state(true)
  let name = $state(initial)
  let saving = $state(false)

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault()
    saving = true
    try {
      await submit(name)
    } finally {
      saving = false
      open = false
      onclose()
    }
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(o) => {
    if (!o) onclose()
  }}
>
  <Dialog.Content class="max-w-sm" data-testid="drive-name-dialog">
    <form class="grid gap-4" {onsubmit}>
      <Dialog.Header>
        <Dialog.Title>{title}</Dialog.Title>
      </Dialog.Header>
      <div class="grid gap-2">
        <Label for="drive-name">{label}</Label>
        <Input id="drive-name" bind:value={name} autocomplete="off" data-testid="drive-name-input" />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => ((open = false), onclose())}>Cancel</Button>
        <Button type="submit" disabled={saving || !name.trim()} data-testid="drive-name-save">Save</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
