<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import DnsStatus from '$lib/components/email/dns-status.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  let { data, form }: PageProps = $props()
  let busy = $state(false)
</script>

<SectionHeader
  title="Domains"
  description="Mail is sent from your own domain. Each domain gets its own DKIM key and four DNS records; once Amazon sees them, you can send from any address at it."
/>

{#if !data.email.configured}
  <p class="mt-4 text-sm text-muted-foreground">
    Connect Amazon SES first — <a class="underline underline-offset-4" href={resolve('/m/email')}>on the Overview</a>.
  </p>
{:else}
  {#if data.email.isAdmin}
    <form
      method="POST"
      action="?/add"
      class="mt-5 flex max-w-2xl flex-wrap items-end gap-3"
      data-testid="domain-add"
      use:enhance={() => {
        busy = true
        return async ({ update }) => {
          await update()
          busy = false
        }
      }}
    >
      <div class="grid min-w-60 flex-1 gap-1.5">
        <Label for="domain-name">Add a domain</Label>
        <Input id="domain-name" name="name" required placeholder="yourcompany.com" autocomplete="off" disabled={busy} />
      </div>
      <Button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add domain'}</Button>
      {#if form?.action === 'add' && 'error' in form}
        <p class="w-full text-sm text-destructive" role="alert">{form.error}</p>
      {/if}
    </form>
  {/if}

  {#if data.domains.length === 0}
    <p class="mt-6 text-sm text-muted-foreground" data-testid="domains-empty">No domains yet.</p>
  {:else}
    <ul class="mt-6 divide-y divide-border rounded-lg border border-border" data-testid="domains-list">
      {#each data.domains as d (d.id)}
        <li>
          <a
            class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted/50 sm:px-5"
            href={resolve(`/m/email/domains/${d.id}`)}
            data-testid={`domain-row-${d.name}`}
          >
            <span class="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</span>
            <span class="text-xs text-muted-foreground">{d.recordsDone} of {d.recordsRequired} required records found</span>
            {#if d.tracking}<span class="text-xs text-muted-foreground">Open & click tracking</span>{/if}
            <DnsStatus status={d.status} />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
