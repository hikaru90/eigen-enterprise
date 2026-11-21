<script lang="ts">
  import { resolve } from '$app/paths'
  import MemoryOwnerLabel from '$lib/components/memory-owner-label.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { ProjectForReader } from '$lib/server/memory/team-projects'

  /**
   * Memory › Projects › Team: the projects colleagues share with everyone, with
   * their owner, progress and next tasks (plan/shared-memory-voice-agent-tools.md §1).
   * Read-only: each opens its project page, where only the owner changes anything.
   */
  let { projects }: { projects: ProjectForReader[] } = $props()

  function statusLabel(status: ProjectForReader['status']): string {
    if (status === 'someday') return m.graph_timeline_project_status_someday()
    if (status === 'completed') return m.graph_timeline_project_status_completed()
    return m.graph_timeline_project_status_active()
  }
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-28" data-testid="team-projects">
  {#if projects.length === 0}
    <p class="text-muted-foreground px-1 py-8 text-center text-sm">{m.memory_team_projects_empty()}</p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each projects as project (project.entityId)}
        {@const visibleTasks = project.tasks.slice(0, 4)}
        <li>
          <a
            href={resolve(`/m/memory/projects/${project.entityId}`)}
            class="flex w-full min-w-0 flex-col gap-y-1 rounded-lg border border-border bg-card px-4 py-3.5 text-left transition-colors hover:bg-muted/50 {project.status ===
            'someday'
              ? 'opacity-50'
              : ''}"
            data-testid="team-project-card"
          >
            <div class="flex w-full min-w-0 items-start justify-between gap-2">
              <p class="truncate text-sm leading-[1.2] text-foreground">{project.label}</p>
              {#if project.openTaskCount > 0}
                <span class="shrink-0 text-xs leading-[1.2] text-muted-foreground">
                  {m.graph_timeline_project_open_loops({ count: project.openTaskCount })}
                </span>
              {/if}
            </div>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <MemoryOwnerLabel name={project.owner.name} />
              <span class="text-xs leading-[1.2] text-foreground">{statusLabel(project.status)}</span>
            </div>
            {#if project.nextAction}
              <div class="flex items-start gap-x-[11px]">
                <span class="shrink-0 text-xs leading-[1.2] text-foreground">Next</span>
                <span class="line-clamp-2 text-xs leading-[1.2] text-muted-foreground">
                  {project.nextAction.summary}
                </span>
              </div>
            {/if}
            {#if visibleTasks.length > 0}
              <ol class="flex flex-col gap-0.5">
                {#each visibleTasks as task (task.itemId)}
                  <li class="text-xs leading-[1.2] text-muted-foreground">{task.rank}. {task.summary}</li>
                {/each}
              </ol>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
