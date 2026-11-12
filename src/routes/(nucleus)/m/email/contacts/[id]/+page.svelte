<script lang="ts">
  import { docTitle } from '$lib/shell/title'
  /* eslint-disable svelte/no-navigation-without-resolve -- the status filter links add a query string to resolve() */
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import CopyButton from '$lib/components/email/copy-button.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  let { data, form }: PageProps = $props()
  const l = $derived(data.list)
  const base = $derived(resolve(`/m/email/contacts/${data.list.id}`))
  const feedback = (action: string) =>
    form && form.action === action
      ? (form as {
          ok?: boolean
          error?: string
          email?: string
          status?: string
          created?: boolean
          added?: number
          updated?: number
          invalid?: string[]
        })
      : null
  const STATUS: Record<string, string> = {
    subscribed: 'Subscribed',
    pending: 'Waiting to confirm',
    unsubscribed: 'Unsubscribed',
  }
  const REASON: Record<string, string> = {
    UNSUBSCRIBED: 'unsubscribed',
    BOUNCED: 'address bounced',
    COMPLAINED: 'marked as spam',
  }
  const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
</script>

<svelte:head><title>{docTitle('Lists', 'Email')}</title></svelte:head>

<div class="mt-8">
  <a
    class="text-[13px] text-muted-foreground hover:text-foreground"
    href={resolve('/m/email/contacts')}>← Back to lists</a
  >
  <h2 class="mt-2 text-base font-semibold tracking-tight" data-testid="list-name">{l.name}</h2>
  {#if l.description}<p class="mt-1 text-sm text-muted-foreground">{l.description}</p>{/if}
</div>

<div class="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
  <div class="min-w-0">
    {#if data.email.isAdmin}
      <form
        method="POST"
        action="?/add"
        class="grid max-w-3xl gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
        use:enhance
        data-testid="contact-add"
      >
        <div class="grid gap-1.5">
          <Label for="contact-email">Add a contact</Label>
          <Input
            id="contact-email"
            name="email"
            type="email"
            required
            placeholder="someone@example.com"
          />
        </div>
        <div class="grid gap-1.5">
          <Label for="contact-first">First name</Label>
          <Input id="contact-first" name="firstName" />
        </div>
        <div class="grid gap-1.5">
          <Label for="contact-last">Last name</Label>
          <Input id="contact-last" name="lastName" />
        </div>
        <Button type="submit">Add</Button>
        {#if feedback('add')?.ok}
          <p class="text-sm sm:col-span-4" role="status" data-testid="contact-added">
            {feedback('add')?.created
              ? feedback('add')?.status === 'pending'
                ? `${feedback('add')?.email} was sent a confirmation mail.`
                : `${feedback('add')?.email} is subscribed.`
              : `${feedback('add')?.email} was already on the list; details updated.`}
          </p>
        {/if}
        {#if feedback('add')?.error}<p class="text-sm text-destructive sm:col-span-4" role="alert">
            {feedback('add')?.error}
          </p>{/if}
      </form>
    {/if}

    <nav class="mt-6 flex gap-1 text-[13px]" aria-label="Filter contacts">
      {#each [['', 'All'], ['subscribed', 'Subscribed'], ['pending', 'Waiting'], ['unsubscribed', 'Unsubscribed']] as [s, label] (s)}
        <a
          class="rounded px-2 py-1 {data.status === s
            ? 'bg-muted font-medium'
            : 'text-muted-foreground hover:text-foreground'}"
          href={s ? `${base}?status=${s}` : base}>{label}</a
        >
      {/each}
    </nav>
    {#if data.contacts.length === 0}
      <p class="mt-3 text-sm text-muted-foreground" data-testid="contacts-empty">
        No contacts{data.status ? ' with this status' : ' yet'}.
      </p>
    {:else}
      <ul
        class="mt-3 divide-y divide-border rounded-lg border border-border"
        data-testid="contacts"
      >
        {#each data.contacts as c (c.id)}
          <li
            class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:px-5"
            data-testid={`contact-${c.email}`}
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{c.email}</span>
              {#if c.name}<span class="block truncate text-xs text-muted-foreground">{c.name}</span
                >{/if}
            </span>
            <span class="text-xs text-muted-foreground" data-testid="contact-status"
              >{STATUS[c.status]}{c.reason ? ` (${REASON[c.reason]})` : ''} · {when(
                c.createdAt,
              )}</span
            >
            {#if data.email.isAdmin}
              <form method="POST" action="?/remove" use:enhance>
                <input type="hidden" name="id" value={c.id} />
                <Button type="submit" size="sm" variant="ghost">Remove</Button>
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if data.email.isAdmin}
    <aside class="flex flex-col gap-6">
      <form
        method="POST"
        action="?/settings"
        class="grid gap-3 rounded-lg border border-border px-4 py-3"
        use:enhance
      >
        <h3 class="text-sm font-medium">List settings</h3>
        <div class="grid gap-1.5">
          <Label for="list-name">Name</Label>
          <Input id="list-name" name="name" value={l.name} required />
        </div>
        <div class="grid gap-1.5">
          <Label for="list-desc">Description (shown on the sign-up page)</Label>
          <Input id="list-desc" name="description" value={l.description ?? ''} />
        </div>
        <label class="flex items-start gap-2 text-sm">
          <input type="checkbox" name="doubleOptIn" class="mt-1" checked={l.doubleOptIn} /> New contacts
          confirm by email (double opt-in)
        </label>
        <label class="flex items-start gap-2 text-sm">
          <input type="checkbox" name="publicSignup" class="mt-1" checked={l.publicSignup} /> Public sign-up
          page
        </label>
        {#if l.publicSignup}
          <p class="flex items-center gap-1 text-xs text-muted-foreground">
            <code class="truncate font-mono">{data.signupUrl}</code><CopyButton
              value={data.signupUrl}
              label="Copy the sign-up link"
            />
          </p>
        {/if}
        <Button type="submit" size="sm" variant="outline">Save settings</Button>
        {#if feedback('settings')?.error}<p class="text-sm text-destructive">
            {feedback('settings')?.error}
          </p>{/if}
      </form>

      <form
        method="POST"
        action="?/import"
        class="grid gap-2 rounded-lg border border-border px-4 py-3"
        use:enhance
      >
        <h3 class="text-sm font-medium">Import</h3>
        <p class="text-xs text-muted-foreground">
          One per line: email, first name, last name. Only import people who agreed to hear from you
          — they are added as subscribed.
        </p>
        <textarea
          name="csv"
          rows="5"
          class="rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
          placeholder="ada@example.com, Ada, Lovelace"></textarea>
        <Button type="submit" size="sm" variant="outline">Import</Button>
        {#if feedback('import')?.ok}
          <p class="text-sm" role="status">
            {feedback('import')?.added} added, {feedback('import')?.updated} updated{feedback(
              'import',
            )?.invalid?.length
              ? `; skipped: ${feedback('import')?.invalid?.join(', ')}`
              : ''}.
          </p>
        {/if}
      </form>

      <form
        method="POST"
        action="?/delete"
        use:enhance={({ cancel }) => {
          if (!confirm(`Delete “${l.name}” and all its contacts?`)) cancel()
        }}
      >
        <Button type="submit" size="sm" variant="ghost" class="text-destructive">Delete list</Button
        >
      </form>
    </aside>
  {/if}
</div>
