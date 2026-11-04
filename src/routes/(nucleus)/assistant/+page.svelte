<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import { useAssistant } from '$lib/components/assistant/context'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()

  const assistant = useAssistant()
  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = (iso: string) => timeFormat.format(new Date(iso))
</script>

<svelte:head><title>{docTitle('Conversations', 'Assistant')}</title></svelte:head>

<SectionHeader
  title="Conversations"
  description="Every conversation the assistant has had, live as it happens."
>
  {#snippet actions()}
    <Button size="sm" onclick={() => assistant.newConversation()} data-testid="runs-new"
      >New conversation</Button
    >
  {/snippet}
</SectionHeader>

{#if data.runs.length === 0}
  <div
    class="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 text-sm text-foreground/55"
    data-testid="runs-empty"
  >
    <span>No conversations yet. Ask the assistant anything and it starts one.</span>
    <Button size="sm" variant="outline" onclick={() => assistant.focusBar()}
      >Ask the assistant</Button
    >
  </div>
{:else}
  <ul
    class="mt-6 divide-y divide-border overflow-hidden rounded-lg border border-border"
    data-testid="runs-list"
  >
    {#each data.runs as run (run.id)}
      <li>
        <a
          href={resolve('/(nucleus)/assistant/[id]', { id: String(run.id) })}
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
