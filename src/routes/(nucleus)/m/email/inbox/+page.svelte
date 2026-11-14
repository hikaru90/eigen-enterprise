<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- every href and goto target is built by inboxHref() on resolve('/m/email/inbox') */
  import type { Folder } from '../../../../../../modules/email/inbox/types'
  import type { MessageListItem } from '../../../../../../modules/email/inbox/view'
  import type { PageProps } from './$types'
  import type { SubmitFunction } from '@sveltejs/kit'
  import Check from '@lucide/svelte/icons/check'
  import PenLine from '@lucide/svelte/icons/pen-line'
  import Tag from '@lucide/svelte/icons/tag'
  import { onDestroy, onMount, tick } from 'svelte'
  import { deserialize, enhance } from '$app/forms'
  import { afterNavigate, goto, invalidate } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { navigating } from '$app/state'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { ResumableStream } from '$lib/messages/resumable-stream'
  import { docTitle } from '$lib/shell/title'
  import ProposalCard from '../../../../../../modules/calendar/ui/proposal-card.svelte'
  import ComposeForm from '../../../../../../modules/email/inbox/ui/compose-form.svelte'
  import { labelDot } from '../../../../../../modules/email/inbox/ui/display'
  import FolderNav from '../../../../../../modules/email/inbox/ui/folder-nav.svelte'
  import MailReader from '../../../../../../modules/email/inbox/ui/mail-reader.svelte'
  import MessageList from '../../../../../../modules/email/inbox/ui/message-list.svelte'
  import { inboxHref, type InboxState } from '../../../../../../modules/email/inbox/url'
  import { FOLDER_LABELS } from '../../../../../../modules/email/inbox/view'
  import { INBOX_DEPENDENCY } from './dependency'

  /**
   * Email › Inbox (plan/email-inbox.md §4, S4): mailbox switcher, folders,
   * one folder's mail, the open thread. The URL holds the state. Opening a
   * mail marks it read with an explicit POST from the click (or, for a mail
   * opened by link, once on mount). New mail arrives over the live stream,
   * which only says which mailbox changed; the page then reloads its data.
   */
  let { data }: PageProps = $props()

  const base = resolve('/m/email/inbox')
  let busy = $state(false)
  let actionError = $state<string | null>(null)
  let live = $state<'connecting' | 'live' | 'reconnecting'>('connecting')
  let reader: ReturnType<typeof MailReader> | undefined = $state()
  let sending = $state(false)
  let sendError = $state<string | null>(null)

  const inbox = $derived(data.inbox)
  /** Where the list is: a folder, Starred, or a label (with its search, filter and sort). */
  const place = $derived<Partial<InboxState>>(
    inbox
      ? {
          box: inbox.box.id,
          ...(inbox.folder ? { folder: inbox.folder } : {}),
          ...(inbox.view ? { view: inbox.view } : {}),
          ...(inbox.label ? { label: inbox.label.id } : {}),
          sort: inbox.sort,
        }
      : {},
  )
  const here = $derived<Partial<InboxState>>(inbox ? { ...place, q: inbox.q, filter: inbox.filter } : {})
  const folderLabel = $derived(
    !inbox ? '' : inbox.label ? inbox.label.name : inbox.view === 'starred' ? 'Starred' : FOLDER_LABELS[inbox.folder ?? 'inbox'],
  )
  const listHref = $derived(inboxHref(base, here))
  const filterLabel = $derived(inbox?.filter === 'unread' ? 'unread ' : '')
  const emptyText = $derived(
    inbox?.q
      ? `No ${filterLabel}mail in ${folderLabel} matches “${inbox.q}”.`
      : inbox?.filter === 'unread'
        ? `No unread mail in ${folderLabel}.`
        : inbox?.filter === 'attachments'
          ? `No mail with attachments in ${folderLabel}.`
          : inbox?.view === 'starred'
            ? 'Nothing starred. Star a mail to find it here.'
            : inbox?.label
              ? `No mail labelled ${inbox.label.name}.`
              : inbox?.folder === 'inbox'
                ? 'No mail in your inbox.'
                : `Nothing in ${folderLabel}.`,
  )
  const currentPlace = $derived(
    !inbox
      ? ({ kind: 'folder', folder: 'inbox' } as const)
      : inbox.label
        ? ({ kind: 'label', labelId: inbox.label.id } as const)
        : inbox.view === 'starred'
          ? ({ kind: 'starred' } as const)
          : ({ kind: 'folder', folder: inbox.folder ?? 'inbox' } as const),
  )

  const folderHref = (folder: Folder) => inboxHref(base, { box: inbox?.box.id, folder, sort: inbox?.sort })
  const starredHref = $derived(inboxHref(base, { box: inbox?.box.id, view: 'starred', sort: inbox?.sort }))
  const labelHref = (id: string) => inboxHref(base, { box: inbox?.box.id, label: id, sort: inbox?.sort })
  const filterHref = (filter: 'unread' | 'attachments' | null) => inboxHref(base, { ...place, q: inbox?.q, filter })
  const sortHref = (sort: 'oldest' | null) => inboxHref(base, { ...here, sort })
  const readerLabels = $derived(inbox ? inbox.labels.filter((l) => inbox.readerLabelIds.includes(l.id)) : [])
  /** Places for the phone-width picker (the sidebar is hidden there). */
  const places = $derived(
    inbox
      ? [
          ...inbox.folders
            .filter((f) => f.folder === 'inbox')
            .map((f) => ({ href: folderHref(f.folder), label: f.unread > 0 ? `${f.label} (${f.unread})` : f.label, here: currentPlace.kind === 'folder' && currentPlace.folder === f.folder })),
          { href: starredHref, label: 'Starred', here: currentPlace.kind === 'starred' },
          ...inbox.folders
            .filter((f) => f.folder !== 'inbox')
            .map((f) => ({ href: folderHref(f.folder), label: f.label, here: currentPlace.kind === 'folder' && currentPlace.folder === f.folder })),
          ...inbox.labels.map((l) => ({ href: labelHref(l.id), label: `Label: ${l.name}`, here: currentPlace.kind === 'label' && currentPlace.labelId === l.id })),
        ]
      : [],
  )
  const newMailHref = $derived(inboxHref(base, { ...here, compose: 'new' }))
  /** Where Discard goes: the opened mail (a reply or forward), else the list. */
  const discardHref = $derived(inbox?.reader ? inboxHref(base, { ...here, m: inbox.reader.id }) : listHref)
  const composeLinks = $derived(
    inbox?.reader && !inbox.box.disabled
      ? {
          reply: inboxHref(base, { ...here, m: inbox.reader.id, compose: 'reply' }),
          replyAll: inboxHref(base, { ...here, m: inbox.reader.id, compose: 'replyAll' }),
          forward: inboxHref(base, { ...here, m: inbox.reader.id, compose: 'forward' }),
        }
      : null,
  )
  /** One compose form per draft: a new mode or parent starts a fresh form; reloads of the same one keep what was typed. */
  const composeKey = $derived(inbox?.compose ? `${inbox.compose.mode}:${inbox.compose.parentId ?? ''}:${inbox.box.id}` : '')
  const messageHref = (id: string) => inboxHref(base, { ...here, m: id })
  /** Calendar K7: the appointment's day in Calendar, and its dialog there (Edit). */
  const calendarBase = resolve('/m/calendar')
  const proposalLinks = $derived(
    inbox?.proposal
      ? {
          edit: `${calendarBase}?date=${inbox.proposal.localStart.slice(0, 10)}&proposal=${inbox.proposal.id}`,
          day: `${calendarBase}?date=${inbox.proposal.localStart.slice(0, 10)}`,
        }
      : null,
  )

  /** A form action called from code (not a form): same endpoint and result shape as use:enhance. */
  async function post(action: 'read', messageId: string): Promise<string | null> {
    const body = new FormData()
    body.set('messageId', messageId)
    const res = await fetch(`${base}?/${action}`, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } })
    const result = deserialize(await res.text())
    if (result.type === 'success') return null
    if (result.type === 'failure') return String((result.data as { error?: unknown } | undefined)?.error)
    return `Could not mark the mail read (HTTP ${res.status}).`
  }

  async function open(item: MessageListItem, event: MouseEvent) {
    event.preventDefault()
    actionError = null
    if (item.unread) actionError = await post('read', item.id)
    await goto(messageHref(item.id))
    await tick()
    reader?.focusHeading()
  }

  const submit: SubmitFunction = ({ action }) => {
    busy = true
    actionError = null
    const moving = action.search === '?/move'
    return async ({ result, update }) => {
      busy = false
      if (result.type === 'failure') {
        actionError = String((result.data as { error?: unknown } | undefined)?.error)
        return
      }
      // A moved mail leaves this folder: back to the list.
      if (result.type === 'success' && moving) await goto(listHref, { invalidateAll: true })
      else await update()
    }
  }

  /** Send: on success show the copy in Sent with a confirmation; on failure keep the form as typed and say why. */
  const sendSubmit: SubmitFunction = () => {
    sending = true
    sendError = null
    return async ({ result }) => {
      sending = false
      if (result.type === 'success') {
        const sent = (result.data as { sent?: { id: string; mailboxId: string } } | undefined)?.sent
        if (!sent) {
          sendError = 'The mail was sent, but the page could not open it. Look in Sent.'
          return
        }
        await goto(inboxHref(base, { box: sent.mailboxId, folder: 'sent', m: sent.id, sent: true }), { invalidateAll: true })
        await tick()
        document.getElementById('inbox-sent-confirmation')?.focus()
        return
      }
      if (result.type === 'failure') {
        sendError = String((result.data as { error?: unknown } | undefined)?.error)
        return
      }
      if (result.type === 'error') {
        sendError = 'The mail could not be sent. Nothing went out; try again in a moment.'
        return
      }
      // A redirect (signed out): follow it.
      await goto(result.location)
    }
  }

  /** The mailbox picker submits on change (a GET form, so it also works without JavaScript). */
  function pickMailbox(event: Event) {
    ;(event.currentTarget as HTMLSelectElement).form?.requestSubmit()
  }

  /** The phone-width place picker: each option is a link target. */
  function pickPlace(event: Event) {
    void goto((event.currentTarget as HTMLSelectElement).value)
  }

  /** Label changes, label creation and removal: reload in place, errors shown like the reader's. */
  const labelSubmit: SubmitFunction = () => {
    actionError = null
    return async ({ result, update }) => {
      if (result.type === 'failure') {
        actionError = String((result.data as { error?: unknown } | undefined)?.error)
        return
      }
      await update({ reset: true })
    }
  }

  let creating = $state(false)
  let createError = $state<string | null>(null)
  const createSubmit: SubmitFunction = () => {
    creating = true
    createError = null
    return async ({ result, update }) => {
      creating = false
      if (result.type === 'failure') {
        createError = String((result.data as { error?: unknown } | undefined)?.error)
        return
      }
      await update()
    }
  }

  // ── live updates ──────────────────────────────────────────────────────────
  let stream: ResumableStream | null = null
  /** A reload asked for while a navigation runs: invalidate() would cancel that navigation, so it waits. */
  let refreshAfterNavigation = false

  function refresh() {
    if (navigating.to) refreshAfterNavigation = true
    else void invalidate(INBOX_DEPENDENCY)
  }

  afterNavigate(() => {
    // Leaving the compose form drops its error (a new form starts clean).
    if (!data.inbox?.compose) sendError = null
    if (!refreshAfterNavigation) return
    refreshAfterNavigation = false
    void invalidate(INBOX_DEPENDENCY)
  })

  function onStatus(status: 'live' | 'reconnecting') {
    const wasDown = live === 'reconnecting'
    live = status
    // No event log to catch up from: whatever arrived while disconnected comes with a reload.
    if (status === 'live' && wasDown) refresh()
  }

  function onEvent(_type: string, payload: unknown) {
    const { mailboxId } = payload as { mailboxId: string }
    if (data.inbox && mailboxId === data.inbox.box.id) refresh()
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') stream?.resume()
  }
  function onOnline() {
    stream?.resume()
  }

  onMount(() => {
    if (!data.inbox) return
    stream = new ResumableStream({ url: () => '/api/mail/inbox/stream', initialCursor: 0, events: ['mailbox'], onEvent, onStatus })
    stream.connect()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    // A mail opened by link (not by a click in the list) is read once the page shows it.
    const opened = data.inbox.reader
    if (opened?.unread) {
      void post('read', opened.id).then((err) => {
        actionError = err
        if (!err) refresh()
      })
    }
  })

  onDestroy(() => {
    stream?.close()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  })

  const selectClass = 'h-8 rounded-md border border-input bg-background px-2.5 text-sm'
</script>

<svelte:head><title>{docTitle(inbox ? `${folderLabel} · ${inbox.box.address}` : 'Inbox', 'Email')}</title></svelte:head>

{#snippet labelPicker()}
  {#if inbox?.reader}
    <details class="relative" data-testid="inbox-label-picker">
      <summary
        class="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-border px-3 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden"
        ><Tag class="size-4" aria-hidden="true" />Label{readerLabels.length > 0 ? ` (${readerLabels.length})` : ''}</summary
      >
      <div class="absolute top-9 right-0 z-20 w-56 rounded-lg border border-border bg-popover p-1 shadow-md">
        {#if inbox.labels.length === 0}
          <p class="px-2 py-1.5 text-xs text-muted-foreground">No labels yet. Make one with + next to Labels.</p>
        {/if}
        {#each inbox.labels as l (l.id)}
          {@const isOn = inbox.readerLabelIds.includes(l.id)}
          <form method="POST" action="?/label" use:enhance={labelSubmit}>
            <input type="hidden" name="messageId" value={inbox.reader.id} />
            <input type="hidden" name="labelId" value={l.id} />
            <input type="hidden" name="on" value={isOn ? '0' : '1'} />
            <button
              type="submit"
              role="menuitemcheckbox"
              aria-checked={isOn}
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-muted focus-visible:bg-muted"
              data-testid={`inbox-label-toggle-${l.id}`}
            >
              <span class="size-2.5 shrink-0 rounded-full" style:background={labelDot(l.color)} aria-hidden="true"></span>
              <span class="min-w-0 flex-1 truncate">{l.name}</span>
              {#if isOn}<Check class="size-3.5" aria-hidden="true" />{/if}
            </button>
          </form>
        {/each}
      </div>
    </details>
    {#each readerLabels as l (l.id)}
      <span class="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs" data-testid="inbox-reader-label"
        ><span class="size-1.5 rounded-full" style:background={labelDot(l.color)} aria-hidden="true"></span>{l.name}</span
      >
    {/each}
  {/if}
{/snippet}

{#if data.start}
  <section class="mt-2 max-w-2xl rounded-lg border border-border p-5" data-testid="inbox-no-mailbox" aria-labelledby="inbox-start-heading">
    <h2 id="inbox-start-heading" class="text-base font-medium">Set up your inbox</h2>
    {#if !data.start.canCreate}
      <p class="mt-1 text-sm text-muted-foreground">
        You have no mailbox yet. The owner or an admin gives you one under Setup › Mailboxes; your mail shows here once they do.
      </p>
    {:else if data.start.domains.length === 0}
      <p class="mt-1 text-sm text-muted-foreground">
        A mailbox lives on a verified domain, and there is none yet. Add your domain under Setup › Account; if it is already set up in
        Amazon SES, ee uses it as it is.
      </p>
      <Button class="mt-4" size="sm" href={resolve('/m/email/setup')} data-testid="inbox-start-domain">Go to Setup › Account</Button>
    {:else}
      <p class="mt-1 text-sm text-muted-foreground">
        Pick your address. You can send from it right away; mail to it arrives here once receiving is on for its domain.
      </p>
      <form
        method="POST"
        action="?/createMine"
        class="mt-4 flex flex-wrap items-center gap-2"
        data-testid="inbox-create-mine"
        use:enhance={createSubmit}
      >
        <label class="sr-only" for="inbox-mine-local">Address before the @</label>
        <Input id="inbox-mine-local" name="localPart" required value={data.start.suggested ?? ''} class="h-8 w-48" autocomplete="off" />
        <span class="text-sm text-muted-foreground">@</span>
        <label class="sr-only" for="inbox-mine-domain">Domain</label>
        <select id="inbox-mine-domain" name="domainId" class={selectClass}>
          {#each data.start.domains as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
        </select>
        <Button type="submit" size="sm" disabled={creating}>{creating ? 'Creating…' : 'Create my mailbox'}</Button>
        {#if createError}<p class="w-full text-sm text-destructive" role="alert">{createError}</p>{/if}
      </form>
      <p class="mt-3 text-xs text-muted-foreground">Shared addresses (info@, sales@) and mailboxes for others are under Setup › Mailboxes.</p>
    {/if}
  </section>
{:else if inbox}
  <div class="mt-2 flex flex-col gap-3" data-testid="inbox" data-live={live} data-mailbox={inbox.box.id}>
    {#if inbox.sent && !inbox.compose}
      <p
        id="inbox-sent-confirmation"
        tabindex="-1"
        class="rounded-lg border border-border px-3 py-2 text-[13px] outline-none"
        role="status"
        data-testid="inbox-sent-confirmation"
      >
        Sent. Your copy is in Sent.
      </p>
    {/if}
    {#if inbox.box.disabled}
      <p class="text-[13px] text-muted-foreground" data-testid="inbox-disabled">This address receives no new mail. What it holds stays here.</p>
    {/if}
    {#if inbox.receivingOff}
      <p class="rounded-lg border border-border px-3 py-2 text-[13px] text-muted-foreground" data-testid="inbox-receiving-off">
        Sending from {inbox.box.address} works. To receive mail here, turn on receiving for
        <a class="text-foreground underline underline-offset-4" href={resolve(`/m/email/domains/${inbox.receivingOff.domainId}`)}>{inbox.receivingOff.domain}</a>
        (it changes where mail for the domain is delivered).
      </p>
    {/if}
    {#if inbox.searchError}<p class="text-sm text-destructive" role="alert">{inbox.searchError}</p>{/if}
    {#if actionError && !inbox.reader}<p class="text-sm text-destructive" role="alert">{actionError}</p>{/if}

    <div class="grid gap-4 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
      <aside class="hidden flex-col gap-4 lg:flex" aria-label="Mailbox">
        <Button href={newMailHref} class="w-full justify-start" data-testid="inbox-new-mail"><PenLine aria-hidden="true" />New mail</Button>
        {#if inbox.boxes.length > 1}
          <form method="GET" action={base} class="flex flex-col gap-1" data-testid="inbox-mailbox-switcher">
            <label for="inbox-box" class="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Mailbox</label>
            <select id="inbox-box" name="box" class={selectClass} value={inbox.box.id} onchange={pickMailbox}>
              {#each inbox.boxes as b (b.id)}
                <option value={b.id}>{b.address}{b.kind === 'shared' ? ' (shared)' : ''}</option>
              {/each}
            </select>
            <noscript><Button type="submit" size="sm" variant="outline">Open</Button></noscript>
          </form>
        {:else}
          <p class="truncate px-1 text-[13px] text-muted-foreground" data-testid="inbox-address" title={inbox.box.address}>{inbox.box.address}</p>
        {/if}
        <FolderNav
          folders={inbox.folders}
          current={currentPlace}
          href={folderHref}
          {starredHref}
          labels={inbox.labels}
          {labelHref}
          mailboxId={inbox.box.id}
          submit={labelSubmit}
        />
      </aside>

      <div class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2 lg:hidden">
          {#if inbox.boxes.length > 1}
            <form method="GET" action={base}>
              <label class="sr-only" for="inbox-box-narrow">Mailbox</label>
              <select id="inbox-box-narrow" name="box" class={selectClass} value={inbox.box.id} onchange={pickMailbox}>
                {#each inbox.boxes as b (b.id)}<option value={b.id}>{b.address}{b.kind === 'shared' ? ' (shared)' : ''}</option>{/each}
              </select>
            </form>
          {/if}
          <label class="sr-only" for="inbox-place">Folder or label</label>
          <select id="inbox-place" class={selectClass} onchange={pickPlace} data-testid="inbox-place-picker">
            {#each places as p (p.href)}<option value={p.href} selected={p.here}>{p.label}</option>{/each}
          </select>
          <Button href={newMailHref} size="sm" class="ml-auto"><PenLine aria-hidden="true" />New mail</Button>
        </div>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 class="text-base font-medium" data-testid="inbox-place">{folderLabel}</h2>
          <form method="GET" action={base} role="search" class="flex min-w-0 flex-1 items-center gap-2 sm:max-w-sm" data-testid="inbox-search">
            <input type="hidden" name="box" value={inbox.box.id} />
            {#if inbox.folder && !inbox.view && !inbox.label}<input type="hidden" name="folder" value={inbox.folder} />{/if}
            {#if inbox.view}<input type="hidden" name="view" value={inbox.view} />{/if}
            {#if inbox.label}<input type="hidden" name="label" value={inbox.label.id} />{/if}
            {#if inbox.filter}<input type="hidden" name="filter" value={inbox.filter} />{/if}
            {#if inbox.sort}<input type="hidden" name="sort" value={inbox.sort} />{/if}
            <Input name="q" type="search" value={inbox.q ?? ''} placeholder={`Search ${folderLabel}`} aria-label={`Search ${folderLabel}`} class="h-8" />
            <Button type="submit" size="sm" variant="outline">Search</Button>
          </form>
          {#if live === 'reconnecting'}<span class="text-xs text-muted-foreground" role="status">Reconnecting…</span>{/if}
        </div>

        <div class="grid min-h-[28rem] overflow-hidden rounded-lg border border-border md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
          <section class="min-w-0 border-border md:border-r {inbox.reader || inbox.compose ? 'hidden md:block' : ''}" aria-label={`${folderLabel} list`}>
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
              <nav class="flex gap-0.5" aria-label="Filter" data-testid="inbox-filters">
                {#each [{ id: null, label: 'All' }, { id: 'unread', label: 'Unread' }, { id: 'attachments', label: 'Attachments' }] as const as f (f.label)}
                  <a
                    href={filterHref(f.id)}
                    aria-current={inbox.filter === f.id ? 'true' : undefined}
                    data-testid={`inbox-filter-${f.id ?? 'all'}`}
                    class="rounded-md px-2 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60 {inbox.filter === f.id
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground'}">{f.label}</a
                  >
                {/each}
              </nav>
              <a
                href={sortHref(inbox.sort === 'oldest' ? null : 'oldest')}
                class="text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                data-testid="inbox-sort"
                aria-label={inbox.sort === 'oldest' ? 'Sorted oldest first. Sort newest first' : 'Sorted newest first. Sort oldest first'}
                >{inbox.sort === 'oldest' ? 'Oldest first' : 'Newest first'} ↕</a
              >
            </div>
            {#if inbox.q}
              <p class="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
                <span class="truncate">Results for “{inbox.q}”</span>
                <a class="underline-offset-4 hover:underline" href={inboxHref(base, { ...place, filter: inbox.filter })}>Clear</a>
              </p>
            {/if}
            <MessageList
              messages={inbox.messages}
              labels={inbox.labels}
              selectedId={inbox.reader?.id ?? null}
              label={`Mail in ${folderLabel}`}
              empty={emptyText}
              href={messageHref}
              onopen={open}
            />
          </section>
          <section
            class="min-w-0 {inbox.reader || inbox.compose ? '' : 'hidden md:flex md:items-center md:justify-center'}"
            aria-label={inbox.compose ? 'Compose' : 'Reading pane'}
          >
            {#if inbox.compose}
              {#key composeKey}
                <ComposeForm draft={inbox.compose} submit={sendSubmit} {discardHref} busy={sending} error={sendError} />
              {/key}
            {:else if inbox.reader}
              {#if inbox.proposal && proposalLinks}
                <div class="border-b border-border p-3">
                  <ProposalCard proposal={inbox.proposal} editHref={proposalLinks.edit} calendarHref={proposalLinks.day} />
                </div>
              {/if}
              {#key inbox.reader.id}
                <MailReader
                  bind:this={reader}
                  reader={inbox.reader}
                  backHref={listHref}
                  imagesHref={inboxHref(base, { ...here, m: inbox.reader.id, images: true })}
                  {submit}
                  {busy}
                  error={actionError}
                  compose={composeLinks}
                  extra={labelPicker}
                />
              {/key}
            {:else}
              <p class="px-4 py-6 text-sm text-muted-foreground">Pick a mail to read it.</p>
            {/if}
          </section>
        </div>
      </div>
    </div>
  </div>
{/if}
