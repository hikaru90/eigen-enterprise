<script lang="ts">
  import type { PageProps } from './$types'
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
  import PinIcon from '@lucide/svelte/icons/pin'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { docTitle } from '$lib/shell/title'

  /**
   * Memory → Projects → Roadmap (P-4): the company's system project as a
   * board of its tasks — planned · in progress · shipped. The owner and
   * admins add, edit and move items; members read. The agent edits the same
   * tasks through the roadmap tools. Empty columns say so — no filler.
   */

  let { data, form }: PageProps = $props()

  type Status = 'planned' | 'in_progress' | 'shipped'
  const columns: Array<{ status: Status; title: string; empty: string; dot: string }> = [
    {
      status: 'planned',
      title: 'Planned',
      empty: 'Nothing planned.',
      dot: 'bg-muted-foreground/40',
    },
    {
      status: 'in_progress',
      title: 'In progress',
      empty: 'Nothing in progress.',
      dot: 'bg-primary',
    },
    { status: 'shipped', title: 'Shipped', empty: 'Nothing shipped yet.', dot: 'bg-foreground' },
  ]
  const moves: Record<Status, Array<{ to: Status; label: string }>> = {
    planned: [{ to: 'in_progress', label: 'Start' }],
    in_progress: [
      { to: 'planned', label: 'Back to planned' },
      { to: 'shipped', label: 'Mark shipped' },
    ],
    shipped: [{ to: 'in_progress', label: 'Reopen' }],
  }
  const kinds = ['feature', 'fix', 'chore'] as const

  let adding = $state(false)
  let editing = $state<string | null>(null)

  const itemsIn = (status: Status) => data.items.filter((item) => item.status === status)
  const shippedOn = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '')
  const selectClass =
    'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60'
</script>

<svelte:head>
  <title>{docTitle('Roadmap', 'Memory')}</title>
</svelte:head>

<div
  class="flex min-h-0 w-full flex-1 flex-col px-4 pt-6 pb-10 sm:px-8"
  data-testid="roadmap-project-page"
>
  <header class="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
    <div class="min-w-0">
      <a
        href={resolve('/m/memory/projects')}
        class="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon class="size-3.5" aria-hidden="true" />
        Projects
      </a>
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-base font-semibold">Roadmap</h2>
        <Badge variant="outline" class="gap-1" data-testid="roadmap-system-badge">
          <PinIcon class="size-3" aria-hidden="true" />
          System project
        </Badge>
      </div>
      <p class="mt-1 max-w-2xl text-sm text-muted-foreground">
        The company's plan — what is planned, what is being built, what shipped. You and the agent
        keep it; its items are this project's tasks.
      </p>
    </div>
    {#if data.canEdit && !adding}
      <Button
        size="sm"
        class="gap-1"
        onclick={() => (adding = true)}
        data-testid="roadmap-add-open"
      >
        <PlusIcon class="size-3.5" aria-hidden="true" />
        Add item
      </Button>
    {:else if !data.canEdit}
      <p class="text-xs text-muted-foreground" data-testid="roadmap-read-only">
        Only the owner and admins change the roadmap.
      </p>
    {/if}
  </header>

  {#if form && 'error' in form && form.error}
    <p class="mt-4 text-sm text-destructive" role="alert">{form.error}</p>
  {/if}

  {#if data.canEdit && adding}
    <form
      method="POST"
      action="?/add"
      class="mt-6 flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card p-4"
      data-testid="roadmap-add-form"
      use:enhance={() =>
        async ({ result, update }) => {
          await update()
          if (result.type === 'success') adding = false
        }}
    >
      <Input name="title" placeholder="What should be built?" aria-label="Title" required />
      <Textarea name="detail" rows={2} placeholder="Details (optional)" aria-label="Details" />
      <div class="flex flex-wrap items-center gap-2">
        <select name="kind" aria-label="Kind" class={selectClass}>
          {#each kinds as k (k)}<option value={k}>{k}</option>{/each}
        </select>
        <div class="ml-auto flex gap-2">
          <Button type="button" variant="ghost" size="sm" onclick={() => (adding = false)}
            >Cancel</Button
          >
          <Button type="submit" size="sm">Add to planned</Button>
        </div>
      </div>
    </form>
  {/if}

  <div class="mt-6 grid min-h-0 flex-1 gap-4 md:grid-cols-3">
    {#each columns as column (column.status)}
      {@const items = itemsIn(column.status)}
      <section
        class="flex min-w-0 flex-col gap-2 rounded-xl bg-muted/40 p-3"
        aria-label={column.title}
        data-testid="roadmap-{column.status.replace('_', '-')}"
      >
        <h3 class="flex items-center gap-2 px-1 pb-1 text-[13px] font-medium">
          <span class="size-2 rounded-full {column.dot}" aria-hidden="true"></span>
          {column.title}
          <span class="ml-auto text-xs font-normal text-foreground/50 tabular-nums"
            >{items.length}</span
          >
        </h3>
        {#each items as item (item.id)}
          <article
            class="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm shadow-xs"
            data-testid="roadmap-item"
          >
            {#if editing === item.id}
              <form
                method="POST"
                action="?/update"
                class="flex flex-col gap-2"
                use:enhance={() =>
                  async ({ result, update }) => {
                    await update()
                    if (result.type === 'success') editing = null
                  }}
              >
                <input type="hidden" name="id" value={item.id} />
                <Input name="title" value={item.title} aria-label="Title" required />
                <Textarea name="detail" rows={2} value={item.detail} aria-label="Details" />
                <div class="flex flex-wrap items-center gap-2">
                  <select name="kind" aria-label="Kind" class={selectClass} value={item.kind}>
                    {#each kinds as k (k)}<option value={k}>{k}</option>{/each}
                  </select>
                  <div class="ml-auto flex gap-1">
                    <Button type="button" variant="ghost" size="sm" onclick={() => (editing = null)}
                      >Cancel</Button
                    >
                    <Button type="submit" size="sm">Save</Button>
                  </div>
                </div>
              </form>
            {:else}
              <div class="flex items-start justify-between gap-2">
                <p class="min-w-0 font-medium break-words">{item.title}</p>
                <Badge variant="outline" class="shrink-0 capitalize">{item.kind}</Badge>
              </div>
              {#if item.detail}
                <p class="text-xs text-foreground/60">{item.detail}</p>
              {/if}
              {#if item.status === 'shipped'}
                <p class="text-xs text-foreground/50">Shipped {shippedOn(item.shippedAt)}</p>
              {/if}
              {#if data.canEdit}
                <div class="flex flex-wrap gap-1 pt-1">
                  {#each moves[item.status] as move (move.to)}
                    <form method="POST" action="?/update" use:enhance>
                      <input type="hidden" name="id" value={item.id} />
                      <input type="hidden" name="status" value={move.to} />
                      <Button type="submit" variant="outline" size="sm">{move.label}</Button>
                    </form>
                  {/each}
                  <Button variant="ghost" size="sm" onclick={() => (editing = item.id)}>Edit</Button
                  >
                </div>
              {/if}
            {/if}
          </article>
        {:else}
          <p class="px-1 py-2 text-xs text-foreground/50">{column.empty}</p>
        {/each}
      </section>
    {/each}
  </div>
</div>
