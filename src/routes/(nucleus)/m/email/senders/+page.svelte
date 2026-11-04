<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  let { data, form }: PageProps = $props()
  let busy = $state(false)
  const feedback = (action: string) => (form && form.action === action ? (form as { ok?: boolean; error?: string; address?: string }) : null)
</script>

<SectionHeader
  title="Senders"
  description="The addresses your company sends from, with the name recipients see. The default sender sends sign-in codes, notifications and every mail that names no sender."
/>

{#if !data.email.configured}
  <p class="mt-4 text-sm text-muted-foreground">
    Connect Amazon SES first — <a class="underline underline-offset-4" href={resolve('/m/email')}>on the Overview</a>.
  </p>
{:else}
  {#if data.email.isAdmin}
    {#if data.domains.length === 0}
      <p class="mt-5 max-w-2xl text-sm text-muted-foreground" data-testid="senders-need-domain">
        New senders need a verified domain. <a class="underline underline-offset-4" href={resolve('/m/email/domains')}>Add one under Domains</a>.
      </p>
    {:else}
      <form
        method="POST"
        action="?/add"
        class="mt-5 grid max-w-3xl gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        data-testid="sender-add"
        use:enhance={() => {
          busy = true
          return async ({ update }) => {
            await update()
            busy = false
          }
        }}
      >
        <div class="grid gap-1.5">
          <Label for="sender-address">Address</Label>
          <Input id="sender-address" name="address" type="email" required placeholder={`hello@${data.domains[0]}`} disabled={busy} />
        </div>
        <div class="grid gap-1.5">
          <Label for="sender-name">Name recipients see (optional)</Label>
          <Input id="sender-name" name="displayName" placeholder="Your Company" disabled={busy} />
        </div>
        <Button type="submit" disabled={busy}>Add sender</Button>
        {#if feedback('add')?.error}<p class="text-sm text-destructive sm:col-span-3" role="alert">{feedback('add')?.error}</p>{/if}
        <p class="text-xs text-muted-foreground sm:col-span-3">Verified domains: {data.domains.join(', ')}.</p>
      </form>
    {/if}
  {/if}

  {#if feedback('makeDefault')?.error || feedback('remove')?.error}
    <p class="mt-4 text-sm text-destructive" role="alert">{feedback('makeDefault')?.error ?? feedback('remove')?.error}</p>
  {/if}

  <ul class="mt-6 divide-y divide-border rounded-lg border border-border" data-testid="senders-list">
    {#each data.senders as s (s.address)}
      <li class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5" data-testid={`sender-row-${s.address}`}>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{s.displayName ? `${s.displayName} <${s.address}>` : s.address}</span>
          <span class="block text-xs text-muted-foreground">
            {s.domainName ? `On ${s.domainName}` : 'Verified as a single address'}
          </span>
        </span>
        {#if s.isDefault}
          <span class="rounded-full border border-primary/40 px-2 py-0.5 text-[11px] font-medium" data-testid="sender-default">Default</span>
        {:else if data.email.isAdmin && s.id}
          <form method="POST" action="?/makeDefault" use:enhance>
            <input type="hidden" name="id" value={s.id} />
            <Button type="submit" size="sm" variant="outline">Make default</Button>
          </form>
          <form method="POST" action="?/remove" use:enhance>
            <input type="hidden" name="id" value={s.id} />
            <Button type="submit" size="sm" variant="ghost" class="text-destructive">Remove</Button>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
