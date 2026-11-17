<script lang="ts">
  import PlusIcon from '@lucide/svelte/icons/plus'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Memory › Tasks: add a task right where the list is (Contribute e7bdd452 — "when I
   * open Tasks I want to add something"). The person says it is a task, so the shell
   * captures it with category 'task' (kept through enrichment) and reloads the list.
   */
  type Props = {
    /** Saves the trimmed text as a task; rejects with a message when it could not. */
    addTask: (text: string) => Promise<void>
  }

  let { addTask }: Props = $props()
  let text = $state('')
  let busy = $state(false)
  let failure = $state<string | null>(null)
  let field = $state<HTMLInputElement | null>(null)

  const canAdd = $derived(text.trim().length > 0 && !busy)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const task = text.trim()
    if (!task || busy) return
    busy = true
    failure = null
    try {
      await addTask(task)
      text = ''
    } catch (err) {
      failure = m.graph_timeline_add_task_failed({
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      busy = false
      field?.focus()
    }
  }
</script>

<form class="shrink-0 px-3 pt-2 pb-1 sm:px-0" onsubmit={submit} data-testid="timeline-add-task">
  <div class="flex items-center gap-2">
    <Input
      bind:ref={field}
      bind:value={text}
      aria-label={m.graph_timeline_add_task_label()}
      placeholder={m.graph_timeline_add_task_placeholder()}
      autocomplete="off"
      disabled={busy}
      class="h-9"
    />
    <Button
      type="submit"
      variant="outline"
      size="icon"
      class="size-9 shrink-0"
      title={m.graph_timeline_add_task_submit()}
      disabled={!canAdd}
    >
      <PlusIcon class="size-4" aria-hidden="true" />
      <span class="sr-only">{m.graph_timeline_add_task_submit()}</span>
    </Button>
  </div>
  {#if failure}
    <p role="alert" class="text-destructive mt-1 text-xs">{failure}</p>
  {/if}
</form>
