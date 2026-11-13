<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- every href and goto target is built by inboxHref() on resolve('/m/email/inbox') */
  import type { Folder } from '../../../../../../modules/email/inbox/types'
  import type { MessageListItem } from '../../../../../../modules/email/inbox/view'
  import type { PageProps } from './$types'
  import type { SubmitFunction } from '@sveltejs/kit'
  import PenLine from '@lucide/svelte/icons/pen-line'
  import { onDestroy, onMount, tick } from 'svelte'
  import { deserialize } from '$app/forms'
  import { afterNavigate, goto, invalidate } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { navigating } from '$app/state'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { ResumableStream } from '$lib/messages/resumable-stream'
  import { docTitle } from '$lib/shell/title'
  import ProposalCard from '../../../../../../modules/calendar/ui/proposal-card.svelte'
  import ComposeForm from '../../../../../../modules/email/inbox/ui/compose-form.svelte'
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
  const here = $derived<Partial<InboxState>>(inbox ? { box: inbox.box.id, folder: inbox.folder, q: inbox.q } : {})
  const folderLabel = $derived(inbox ? FOLDER_LABELS[inbox.folder] : '')
  const listHref = $derived(inboxHref(base, here))
  const emptyText = $derived(
    inbox?.q ? `No mail in ${folderLabel} matches “${inbox.q}”.` : inbox?.folder === 'inbox' ? 'No mail in your inbox.' : `Nothing in ${folderLabel}.`,
  )

  const folderHref = (folder: Folder) => inboxHref(base, { box: inbox?.box.id, folder })
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

{#if !inbox}
  <p class="mt-6 max-w-2xl text-sm text-muted-foreground" data-testid="inbox-no-mailbox">
    You have no mailbox yet. The owner or an admin assigns one under Setup › Mailboxes.
  </p>
{:else}
  <div class="mt-2 flex flex-col gap-3" data-testid="inbox" data-live={live} data-mailbox={inbox.box.id}>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      {#if inbox.boxes.length > 1}
        <form method="GET" action={base} class="flex items-center gap-2" data-testid="inbox-mailbox-switcher">
          <label for="inbox-box" class="text-[13px] text-muted-foreground">Mailbox</label>
          <select id="inbox-box" name="box" class={selectClass} value={inbox.box.id} onchange={pickMailbox}>
            {#each inbox.boxes as b (b.id)}
              <option value={b.id}>{b.address}{b.kind === 'shared' ? ' (shared)' : ''}</option>
            {/each}
          </select>
          <noscript><Button type="submit" size="sm" variant="outline">Open</Button></noscript>
        </form>
      {:else}
        <p class="text-sm font-medium" data-testid="inbox-address">{inbox.box.address}</p>
      {/if}
      <form method="GET" action={base} role="search" class="flex min-w-0 flex-1 items-center gap-2 sm:max-w-sm" data-testid="inbox-search">
        <input type="hidden" name="box" value={inbox.box.id} />
        <input type="hidden" name="folder" value={inbox.folder} />
        <Input name="q" type="search" value={inbox.q ?? ''} placeholder={`Search ${folderLabel}`} aria-label={`Search ${folderLabel}`} class="h-8" />
        <Button type="submit" size="sm" variant="outline">Search</Button>
      </form>
      {#if live === 'reconnecting'}<span class="text-xs text-muted-foreground" role="status">Reconnecting…</span>{/if}
      <Button href={newMailHref} size="sm" class="ml-auto" data-testid="inbox-new-mail"><PenLine aria-hidden="true" />New mail</Button>
    </div>

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
    {#if inbox.searchError}<p class="text-sm text-destructive" role="alert">{inbox.searchError}</p>{/if}

    <FolderNav folders={inbox.folders} current={inbox.folder} href={folderHref} />

    <div class="grid min-h-[24rem] overflow-hidden rounded-lg border border-border md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <section class="min-w-0 border-border md:border-r {inbox.reader || inbox.compose ? 'hidden md:block' : ''}" aria-label={`${folderLabel} list`}>
        {#if inbox.q}
          <p class="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <span class="truncate">Results for “{inbox.q}”</span>
            <a class="underline-offset-4 hover:underline" href={inboxHref(base, { box: inbox.box.id, folder: inbox.folder })}>Clear</a>
          </p>
        {/if}
        <MessageList
          messages={inbox.messages}
          selectedId={inbox.reader?.id ?? null}
          label={`Mail in ${folderLabel}`}
          empty={emptyText}
          href={messageHref}
          onopen={open}
        />
      </section>
      <section class="min-w-0 {inbox.reader || inbox.compose ? '' : 'hidden md:flex md:items-center md:justify-center'}" aria-label={inbox.compose ? 'Compose' : 'Reading pane'}>
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
            />
          {/key}
        {:else}
          <p class="px-4 py-6 text-sm text-muted-foreground">Pick a mail to read it.</p>
        {/if}
      </section>
    </div>
  </div>
{/if}
