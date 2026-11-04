<script lang="ts">
  import { docTitle } from '$lib/shell/title'
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  let { data, form }: PageProps = $props()
</script>

<svelte:head><title>{docTitle('Contacts', 'Email')}</title></svelte:head>

<SectionHeader
  title="Contacts"
  description="Lists of people who get your mail — a newsletter, your customers. Everyone can unsubscribe with one click; flows start when someone joins a list."
/>

{#if data.email.isAdmin}
  <form
    method="POST"
    action="?/create"
    class="mt-5 flex max-w-2xl flex-wrap items-end gap-3"
    use:enhance
    data-testid="list-create"
  >
    <div class="grid min-w-56 flex-1 gap-1.5">
      <Label for="list-name">New list</Label>
      <Input id="list-name" name="name" required placeholder="e.g. Newsletter" />
    </div>
    <label class="flex h-9 items-center gap-2 text-sm">
      <input type="checkbox" name="doubleOptIn" data-testid="list-doi" /> Ask new contacts to confirm
      (double opt-in)
    </label>
    <Button type="submit">Create list</Button>
    {#if form?.action === 'create' && 'error' in form}<p
        class="w-full text-sm text-destructive"
        role="alert"
      >
        {form.error}
      </p>{/if}
  </form>
{/if}

{#if data.lists.length === 0}
  <p class="mt-6 text-sm text-muted-foreground" data-testid="lists-empty">No lists yet.</p>
{:else}
  <ul class="mt-6 divide-y divide-border rounded-lg border border-border" data-testid="lists">
    {#each data.lists as l (l.id)}
      <li>
        <a
          class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted/50 sm:px-5"
          href={resolve(`/m/email/contacts/${l.id}`)}
          data-testid={`list-row-${l.name}`}
        >
          <span class="min-w-0 flex-1 truncate text-sm font-medium">{l.name}</span>
          <span class="text-xs text-muted-foreground">
            {l.subscribed} subscribed{l.pending
              ? ` · ${l.pending} waiting to confirm`
              : ''}{l.unsubscribed ? ` · ${l.unsubscribed} unsubscribed` : ''}{l.doubleOptIn
              ? ' · double opt-in'
              : ''}
          </span>
        </a>
      </li>
    {/each}
  </ul>
{/if}
