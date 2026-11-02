<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()

  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = (iso: string) => timeFormat.format(new Date(iso))
</script>

<svelte:head><title>{docTitle('Runs', 'Agent')}</title></svelte:head>

<SectionHeader
  title="Runs"
  description="Every conversation the agent has had, live as it happens."
/>

{#if data.runs.length === 0}
  <p
    class="mt-6 rounded-lg border border-border px-4 py-3 text-sm text-foreground/55"
    data-testid="runs-empty"
  >
    No agent runs yet.
  </p>
{:else}
  <ul
    class="mt-6 divide-y divide-border overflow-hidden rounded-lg border border-border"
    data-testid="runs-list"
  >
    {#each data.runs as run (run.id)}
      <li>
        <a
          href={resolve('/(nucleus)/agent/runs/[id]', { id: String(run.id) })}
          class="flex min-w-0 items-center justify-between gap-3 px-4 py-2.5 text-sm outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/60"
          data-testid="runs-item"
        >
          <span class="flex min-w-0 flex-col">
            <span class="truncate font-medium" data-testid="runs-item-title">{run.title}</span>
            <span class="truncate text-xs text-muted-foreground">Started {when(run.createdAt)}</span
            >
          </span>
          <span class="shrink-0 text-xs text-foreground/50 tabular-nums">{when(run.updatedAt)}</span
          >
        </a>
      </li>
    {/each}
  </ul>
{/if}
