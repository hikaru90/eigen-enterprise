<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: PageProps = $props()
  const STATUS: Record<string, string> = { draft: 'Draft', active: 'Running', paused: 'Paused' }
</script>

<svelte:head><title>{docTitle('Flows', 'Email')}</title></svelte:head>

<SectionHeader
  title="Flows"
  description="Automations: when someone joins a list, send them a series of mails — a welcome now, a tip in two days. Each person goes through a flow once."
/>

{#if data.email.isAdmin}
  {#if data.lists.length === 0}
    <p class="mt-5 text-sm text-muted-foreground">
      A flow starts when someone joins a list. <a
        class="underline underline-offset-4"
        href={resolve('/m/email/contacts')}>Create a list</a
      > first.
    </p>
  {:else}
    <form
      method="POST"
      action="?/create"
      class="mt-5 grid max-w-3xl gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      use:enhance
      data-testid="flow-create"
    >
      <div class="grid gap-1.5">
        <Label for="flow-name">New flow</Label>
        <Input id="flow-name" name="name" required placeholder="e.g. Welcome series" />
      </div>
      <div class="grid gap-1.5">
        <Label for="flow-list">Starts when someone joins</Label>
        <select
          id="flow-list"
          name="listId"
          class="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          {#each data.lists as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
        </select>
      </div>
      <Button type="submit">Create flow</Button>
      {#if form?.action === 'create' && 'error' in form}<p
          class="text-sm text-destructive sm:col-span-3"
          role="alert"
        >
          {form.error}
        </p>{/if}
    </form>
  {/if}
{/if}

{#if data.flows.length === 0}
  <p class="mt-6 text-sm text-muted-foreground" data-testid="flows-empty">No flows yet.</p>
{:else}
  <ul class="mt-6 divide-y divide-border rounded-lg border border-border" data-testid="flows">
    {#each data.flows as f (f.id)}
      <li>
        <a
          class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted/50 sm:px-5"
          href={resolve(`/m/email/flows/${f.id}`)}
          data-testid={`flow-row-${f.name}`}
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{f.name}</span>
            <span class="block text-xs text-muted-foreground"
              >{f.trigger ? `When someone joins ${f.trigger}` : 'No list chosen'} · {f.steps} steps</span
            >
          </span>
          <span class="text-xs text-muted-foreground"
            >{f.active} in progress · {f.completed} done</span
          >
          <span
            class="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium {f.status ===
            'active'
              ? 'border-primary/40'
              : 'text-muted-foreground'}">{STATUS[f.status]}</span
          >
        </a>
      </li>
    {/each}
  </ul>
{/if}
