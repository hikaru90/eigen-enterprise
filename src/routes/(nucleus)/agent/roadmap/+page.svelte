<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { docTitle } from '$lib/shell/title'

  /**
   * Agent → Roadmap: a board of planned / in progress / shipped items. The
   * owner and admins add and edit here (the agent edits the same store via
   * the roadmap kernel tools). Empty columns say so — no filler.
   */

  let { data, form }: PageProps = $props()

  type Status = 'planned' | 'in_progress' | 'shipped'
  const columns: Array<{ status: Status; title: string; empty: string }> = [
    { status: 'planned', title: 'Planned', empty: 'Nothing planned.' },
    { status: 'in_progress', title: 'In progress', empty: 'Nothing in progress.' },
    { status: 'shipped', title: 'Shipped', empty: 'Nothing shipped yet.' },
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
  <title>{docTitle('Roadmap', 'Agent')}</title>
</svelte:head>

<SectionHeader title="Roadmap" description="What is planned, what is being built, what shipped.">
  {#snippet actions()}
    {#if data.canEdit && !adding}
      <Button size="sm" onclick={() => (adding = true)} data-testid="roadmap-add-open"
        >Add item</Button
      >
    {/if}
  {/snippet}
</SectionHeader>

{#if form && 'error' in form && form.error}
  <p class="mt-4 text-sm text-destructive" role="alert">{form.error}</p>
{/if}

{#if data.canEdit && adding}
  <form
    method="POST"
    action="?/add"
    class="mt-6 flex flex-col gap-3 rounded-lg border border-border p-4"
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

<div class="mt-6 grid gap-4 md:grid-cols-3">
  {#each columns as column (column.status)}
    {@const items = itemsIn(column.status)}
    <section
      class="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/40 p-3"
      aria-label={column.title}
      data-testid="roadmap-{column.status.replace('_', '-')}"
    >
      <h2 class="flex items-center justify-between px-1 text-[13px] font-medium">
        {column.title}
        <span class="text-xs font-normal text-foreground/50 tabular-nums">{items.length}</span>
      </h2>
      {#each items as item (item.id)}
        <article
          class="flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-sm"
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
                <Button variant="ghost" size="sm" onclick={() => (editing = item.id)}>Edit</Button>
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
