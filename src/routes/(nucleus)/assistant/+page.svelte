<script lang="ts">
  import type { PageData } from './$types'
  import Pencil from '@lucide/svelte/icons/pencil'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { useAssistant } from '$lib/components/assistant/context'
  import RunTitleEditor from '$lib/components/assistant/run-title-editor.svelte'
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
    class="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground"
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
      <li class="group/run flex min-w-0 items-center gap-1 pr-2">
        <RunTitleEditor
          runId={run.id}
          title={run.title}
          renamable={run.renamable}
          {fetch}
          onrenamed={() => void invalidateAll()}
          inputClass="my-1.5 ml-2"
        >
          {#snippet display(start)}
            <a
              href={resolve('/(nucleus)/assistant/[id]', { id: String(run.id) })}
              class="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-2.5 text-sm outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 -ring"
              data-testid="runs-item"
            >
              <span class="flex min-w-0 flex-col">
                <span class="truncate font-medium" data-testid="runs-item-title">{run.title}</span>
                <span class="truncate text-xs text-muted-foreground"
                  >Started {when(run.createdAt)}</span
                >
              </span>
              <span class="shrink-0 text-xs text-muted-foreground tabular-nums"
                >{when(run.updatedAt)}</span
              >
            </a>
            {#if run.renamable}
              <Button
                size="icon"
                variant="ghost"
                class="size-7 shrink-0 text-muted-foreground hover:text-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/run:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
                aria-label="Rename conversation"
                title="Rename"
                data-testid="runs-item-rename"
                onclick={start}
              >
                <Pencil class="size-3.5" aria-hidden="true" />
              </Button>
            {/if}
          {/snippet}
        </RunTitleEditor>
      </li>
    {/each}
  </ul>
{/if}
