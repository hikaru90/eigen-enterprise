<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>{docTitle('Memory')}</title></svelte:head>

<!-- The Memory landing view: just the open tasks, each tagged with its project.
     Dates/segments live under the Tasks tab; settings in the header's right side. -->
<div class="w-full px-4 pt-8 pb-16 sm:px-8">
  <section aria-labelledby="memory-tasks-heading" data-testid="memory-task-list">
    <h2 id="memory-tasks-heading" class="sr-only">Tasks</h2>
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
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
