<script lang="ts">
  import Trash2Icon from '@lucide/svelte/icons/trash-2'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { Button } from '$lib/components/ui/button'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * The trash icon of a Tasks / project row: deletes the thought behind the row for good, after
   * a confirmation — the same Delete as Memory's Overview (Contribute 7fa15491). It used to
   * archive; Archive is the row's own button now.
   */
  type Props = {
    summary: string
    disabled?: boolean
    onConfirm: () => void
  }

  let { summary, disabled = false, onConfirm }: Props = $props()
  let open = $state(false)

  function confirm() {
    open = false
    onConfirm()
  }
</script>

<Button
  type="button"
  variant="outline"
  size="icon"
  class="size-8 hover:text-destructive"
  {disabled}
  title={m.graph_temporal_remove_event()}
  data-testid="temporal-event-delete"
  onclick={() => (open = true)}
>
  <Trash2Icon class="size-3.5" aria-hidden="true" />
  <span class="sr-only">{m.graph_temporal_remove_event()}</span>
</Button>

<AlertDialog.Root bind:open>
  <AlertDialog.Content class="max-w-sm" data-testid="temporal-event-delete-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.graph_temporal_delete_title()}</AlertDialog.Title>
      <AlertDialog.Description>{m.graph_temporal_delete_body({ summary })}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.graph_temporal_delete_cancel()}</AlertDialog.Cancel>
      <Button type="button" variant="destructive" {disabled} onclick={confirm}>
        {m.graph_temporal_delete_confirm()}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
