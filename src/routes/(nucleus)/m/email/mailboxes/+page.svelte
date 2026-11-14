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
  let busy = $state(false)
  let memberId = $state('')
  let localPart = $state('')

  const feedback = (action: string) =>
    form && form.action === action ? (form as { ok?: boolean; error?: string; address?: string }) : null

  /** The change was saved, but Amazon refused to update the receipt rules. */
  const receivingError = $derived(
    form && 'receivingError' in form && typeof form.receivingError === 'string' ? form.receivingError : null,
  )

  const unassigned = $derived(data.admin?.members.filter((m) => m.mailbox === null) ?? [])

  /** Picking a member fills in their suggested address; the owner can still change it. */
  function pickMember(event: Event) {
    memberId = (event.currentTarget as HTMLSelectElement).value
    localPart = unassigned.find((m) => m.id === memberId)?.suggested ?? ''
  }

  const submitting = () => {
    busy = true
    return async ({ update }: { update: () => Promise<void> }) => {
      await update()
      busy = false
    }
  }

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const selectClass =
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50'
</script>

<svelte:head><title>{docTitle('Mailboxes', 'Email')}</title></svelte:head>

<SectionHeader
  title="Mailboxes"
  description="The addresses your company receives mail on. Each member can have their own mailbox — only they can read it, not the owner or admins. Shared addresses like info@ are read by one group."
/>

{#if receivingError}
  <p class="mt-4 max-w-3xl rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive" role="alert" data-testid="mailboxes-receiving-error">
    Saved, but the receiving rules at Amazon could not be updated: {receivingError}
    <a class="underline underline-offset-4" href={resolve('/m/email/setup')}>See Receiving under Setup › Account</a>.
  </p>
{/if}

{#if !data.admin}
  {#if data.mine.length === 0}
    <p class="mt-4 text-sm text-muted-foreground" data-testid="mailboxes-none">
      You have no mailbox yet. The owner or an admin assigns one.
    </p>
  {:else}
    <ul class="mt-6 divide-y divide-border rounded-lg border border-border" data-testid="mailboxes-mine">
      {#each data.mine as b (b.address)}
        <li class="px-4 py-3 text-sm sm:px-5">
          <span class="font-medium">{b.address}</span>
          <span class="text-muted-foreground">
            · {b.kind === 'personal' ? 'Yours' : 'Shared'}{b.disabled ? ' · receives no new mail' : ''}</span
          >
          {#if b.aliases.length}<span class="block text-xs text-muted-foreground">Also: {b.aliases.join(', ')}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
{:else if data.admin.domains.length === 0}
  <p class="mt-4 max-w-2xl text-sm text-muted-foreground" data-testid="mailboxes-need-domain">
    Mailboxes need a verified domain. <a class="underline underline-offset-4" href={resolve('/m/email/setup')}
      >Add one under Setup › Account</a
    >.
  </p>
{:else}
  <section class="mt-6 grid max-w-3xl gap-3" aria-labelledby="assign-heading">
    <h3 id="assign-heading" class="text-sm font-semibold">Give a member a mailbox</h3>
    {#if unassigned.length === 0}
      <p class="text-sm text-muted-foreground">Every member has a mailbox.</p>
    {:else}
      <form
        method="POST"
        action="?/assign"
        class="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
        data-testid="mailbox-assign"
        use:enhance={submitting}
      >
        <div class="grid gap-1.5">
          <Label for="assign-member">Member</Label>
          <select id="assign-member" name="memberId" required class={selectClass} disabled={busy} value={memberId} onchange={pickMember}>
            <option value="" disabled>Pick a member</option>
            {#each unassigned as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
          </select>
        </div>
        <div class="grid gap-1.5">
          <Label for="assign-local">Address</Label>
          <Input id="assign-local" name="localPart" required placeholder="firstname.lastname" bind:value={localPart} disabled={busy} />
        </div>
        <div class="grid gap-1.5">
          <Label for="assign-domain">Domain</Label>
          <select id="assign-domain" name="domainId" required class={selectClass} disabled={busy}>
            {#each data.admin.domains as d (d.id)}<option value={d.id}>@{d.name}</option>{/each}
          </select>
        </div>
        <Button type="submit" disabled={busy}>Assign</Button>
        {#if feedback('assign')?.error}<p class="text-sm text-destructive sm:col-span-4" role="alert">{feedback('assign')?.error}</p>{/if}
        {#if feedback('assign')?.ok}<p class="text-sm sm:col-span-4" role="status">{feedback('assign')?.address} is ready.</p>{/if}
      </form>
    {/if}
  </section>

  <section class="mt-8 grid max-w-3xl gap-3" aria-labelledby="shared-heading">
    <h3 id="shared-heading" class="text-sm font-semibold">Add a shared address</h3>
    {#if data.admin.groups.length === 0}
      <p class="text-sm text-muted-foreground">
        Shared addresses are read by a group. <a class="underline underline-offset-4" href={resolve('/settings/members')}
          >Create a group under Members</a
        > first.
      </p>
    {:else}
      <form
        method="POST"
        action="?/shared"
        class="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
        data-testid="mailbox-shared"
        use:enhance={submitting}
      >
        <div class="grid gap-1.5">
          <Label for="shared-local">Address</Label>
          <Input id="shared-local" name="localPart" required placeholder="info" disabled={busy} />
        </div>
        <div class="grid gap-1.5">
          <Label for="shared-domain">Domain</Label>
          <select id="shared-domain" name="domainId" required class={selectClass} disabled={busy}>
            {#each data.admin.domains as d (d.id)}<option value={d.id}>@{d.name}</option>{/each}
          </select>
        </div>
        <div class="grid gap-1.5">
          <Label for="shared-group">Read by</Label>
          <select id="shared-group" name="groupId" required class={selectClass} disabled={busy}>
            {#each data.admin.groups as g (g.id)}<option value={g.id}>{g.name}</option>{/each}
          </select>
        </div>
        <Button type="submit" disabled={busy}>Add</Button>
        {#if feedback('shared')?.error}<p class="text-sm text-destructive sm:col-span-4" role="alert">{feedback('shared')?.error}</p>{/if}
      </form>
    {/if}
  </section>

  {#each ['alias', 'removeAlias', 'disable', 'enable'] as a (a)}
    {#if feedback(a)?.error}<p class="mt-4 text-sm text-destructive" role="alert">{feedback(a)?.error}</p>{/if}
  {/each}

  {#if data.admin.mailboxes.length === 0}
    <p class="mt-8 text-sm text-muted-foreground" data-testid="mailboxes-empty">No mailboxes yet.</p>
  {:else}
    <ul class="mt-8 divide-y divide-border rounded-lg border border-border" data-testid="mailboxes-list">
      {#each data.admin.mailboxes as b (b.id)}
        <li class="grid gap-2 px-4 py-3 sm:px-5" data-testid={`mailbox-row-${b.address}`}>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{b.address}</span>
              <span class="block text-xs text-muted-foreground">
                {b.kind === 'personal' ? b.holder : `Shared · read by ${b.holder}`} · {b.messages} mails, {b.unread} unread · {size(b.sizeBytes)}
              </span>
            </span>
            {#if b.disabled}
              <span class="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium" data-testid="mailbox-disabled">Receives no new mail</span>
              <form method="POST" action="?/enable" use:enhance>
                <input type="hidden" name="mailboxId" value={b.id} />
                <Button type="submit" size="sm" variant="outline">Turn on</Button>
              </form>
            {:else}
              <form method="POST" action="?/disable" use:enhance>
                <input type="hidden" name="mailboxId" value={b.id} />
                <Button type="submit" size="sm" variant="ghost">Stop receiving</Button>
              </form>
            {/if}
          </div>
          {#if b.aliases.length}
            <ul class="flex flex-wrap gap-2" aria-label={`Aliases of ${b.address}`}>
              {#each b.aliases as alias (alias)}
                <li class="flex items-center gap-1 rounded-full border border-border py-0.5 pr-1 pl-2.5 text-xs">
                  {alias}
                  <form method="POST" action="?/removeAlias" use:enhance>
                    <input type="hidden" name="address" value={alias} />
                    <Button type="submit" size="sm" variant="ghost" class="h-6 px-2 text-destructive" aria-label={`Remove ${alias}`}>Remove</Button>
                  </form>
                </li>
              {/each}
            </ul>
          {/if}
          <form method="POST" action="?/alias" class="flex flex-wrap items-end gap-2" use:enhance={submitting}>
            <input type="hidden" name="mailboxId" value={b.id} />
            <Input name="localPart" required placeholder="another address" class="h-8 w-44" aria-label={`New alias for ${b.address}`} disabled={busy} />
            <select name="domainId" class="h-8 rounded-md border border-input bg-background px-2 text-xs" aria-label="Domain" disabled={busy}>
              {#each data.admin.domains as d (d.id)}<option value={d.id}>@{d.name}</option>{/each}
            </select>
            <Button type="submit" size="sm" variant="outline" disabled={busy}>Add alias</Button>
          </form>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
