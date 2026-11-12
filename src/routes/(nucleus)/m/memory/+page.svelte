<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  /** The task the confirm dialog is about (null = closed). */
  let confirming = $state<PageData['tasks'][number] | null>(null)
  let deleting = $state(false)
</script>

<svelte:head><title>{docTitle('Memory')}</title></svelte:head>

<!-- The Memory landing view: just the open tasks, each tagged with its project.
     Dates/segments live under the Tasks tab; settings in the header's right side. -->
<div class="w-full px-4 pt-8 pb-16 sm:px-8">
  <section aria-labelledby="memory-tasks-heading" data-testid="memory-task-list">
    <h2 id="memory-tasks-heading" class="sr-only">Tasks</h2>
    {#if form?.message}
      <p class="mb-3 text-sm text-destructive" role="alert" data-testid="memory-task-error">
        {form.message}
      </p>
    {/if}
    {#if data.tasks.length === 0}
      <p class="text-sm text-muted-foreground" data-testid="memory-task-list-empty">
        No open tasks.
      </p>
    {:else}
      <ul class="divide-y divide-border rounded-lg border border-border bg-card">
        {#each data.tasks as task (task.id)}
          <li class="flex min-w-0 items-center gap-3 px-4 py-2.5" data-testid="memory-task-row">
            <span class="min-w-0 flex-1 truncate text-sm">{task.summary}</span>
            {#if task.project}
              <a
                href={resolve('/(nucleus)/m/memory/projects/[entityId]', {
                  entityId: task.project.entityId,
                })}
                class="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                data-testid="memory-task-project"
              >
                {task.project.label}
              </a>
            {/if}
            <button
              type="button"
              class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/60"
              aria-label={`Delete “${task.summary}”`}
              title="Delete for good"
              data-testid="memory-task-delete"
              onclick={() => (confirming = task)}
            >
              <Trash2 class="size-4" aria-hidden="true" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<AlertDialog.Root
  open={confirming !== null}
  onOpenChange={(open) => {
    if (!open && !deleting) confirming = null
  }}
>
  <AlertDialog.Content class="max-w-sm" data-testid="memory-task-delete-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>Delete this task for good?</AlertDialog.Title>
      <AlertDialog.Description>
        “{confirming?.summary}” and the thought it came from are removed from your Memory — search,
        dates, projects and the graph. This can’t be undone.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={deleting}>Cancel</AlertDialog.Cancel>
      <form
        method="POST"
        action="?/deleteTask"
        use:enhance={() => {
          deleting = true
          return async ({ update }) => {
            await update()
            deleting = false
            confirming = null
          }
        }}
      >
        <input type="hidden" name="thoughtId" value={confirming?.thoughtId ?? ''} />
        <Button type="submit" variant="destructive" disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </form>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
