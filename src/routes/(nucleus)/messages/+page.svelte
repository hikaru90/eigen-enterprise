<script lang="ts">
  import type { PageData } from './$types'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import Hash from '@lucide/svelte/icons/hash'
  import Lock from '@lucide/svelte/icons/lock'
  import Plus from '@lucide/svelte/icons/plus'
  import { onDestroy, onMount, tick } from 'svelte'
  import { replaceState } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { renderMessageMarkdown } from '$lib/messages/markdown'
  import {
    continuesRun,
    groupByDay,
    mergeMessages,
    setUnread,
    upsertConversation,
    type ConversationView,
    type MessageView,
  } from '$lib/messages/view'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()

  // Page-owned state seeded once from the load (the live stream keeps it current).
  // svelte-ignore state_referenced_locally
  let conversations = $state<ConversationView[]>(data.conversations)
  let selectedId = $state<string | null>(null)
  let messages = $state<MessageView[]>([])
  let hasMore = $state(false)
  let loadingEarlier = $state(false)
  let draft = $state('')
  let sending = $state(false)
  let errorText = $state<string | null>(null)
  let live = $state<'connecting' | 'live' | 'reconnecting'>('connecting')

  let listEl = $state<HTMLDivElement | null>(null)
  let composerEl = $state<HTMLTextAreaElement | null>(null)

  const selected = $derived(conversations.find((c) => c.id === selectedId) ?? null)
  const channels = $derived(conversations.filter((c) => c.kind === 'channel'))
  const dms = $derived(conversations.filter((c) => c.kind === 'dm'))
  const days = $derived(groupByDay(messages))
  const others = $derived(data.people.filter((p) => p.id !== data.me))

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
  const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const body = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`)
    return body
  }

  function scrollToBottom() {
    if (listEl) listEl.scrollTop = listEl.scrollHeight
  }
  const nearBottom = () => !listEl || listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120

  // ── conversation selection ──────────────────────────────────────────────
  async function openConversation(id: string, updateUrl = true) {
    selectedId = id
    messages = []
    hasMore = false
    errorText = null
    // The deep link (?c=…) already carries the id on mount, before the router is up.
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() plus a query string
    if (updateUrl) replaceState(`${resolve('/messages')}?c=${encodeURIComponent(id)}`, {})
    try {
      const pageData = await api<{ messages: MessageView[]; hasMore: boolean }>(
        `/api/messages/conversations/${id}/messages`,
      )
      if (selectedId !== id) return
      messages = pageData.messages
      hasMore = pageData.hasMore
      await tick()
      scrollToBottom()
      composerEl?.focus()
      void markRead(id)
      void reportViewing()
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err)
    }
  }

  function closeConversation() {
    selectedId = null
    replaceState(resolve('/messages'), {})
    void reportViewing()
  }

  async function markRead(id: string) {
    conversations = setUnread(conversations, id, 0)
    await api(`/api/messages/conversations/${id}/read`, { method: 'POST' }).catch((err: unknown) => {
      console.error('[messages] mark read failed', err)
    })
  }

  async function loadEarlier() {
    if (!selectedId || messages.length === 0) return
    loadingEarlier = true
    const id = selectedId
    const before = listEl ? listEl.scrollHeight - listEl.scrollTop : 0
    try {
      const older = await api<{ messages: MessageView[]; hasMore: boolean }>(
        `/api/messages/conversations/${id}/messages?before=${encodeURIComponent(messages[0].id)}`,
      )
      if (selectedId !== id) return
      messages = mergeMessages(messages, older.messages)
      hasMore = older.hasMore
      await tick()
      if (listEl) listEl.scrollTop = listEl.scrollHeight - before
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err)
    } finally {
      loadingEarlier = false
    }
  }

  // ── composer ────────────────────────────────────────────────────────────
  async function send() {
    const body = draft
    if (!selectedId || !body.trim() || sending) return
    sending = true
    errorText = null
    try {
      const { message } = await api<{ message: MessageView }>(
        `/api/messages/conversations/${selectedId}/messages`,
        { method: 'POST', body: JSON.stringify({ body }) },
      )
      draft = ''
      messages = mergeMessages(messages, [message])
      await tick()
      scrollToBottom()
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err)
    } finally {
      sending = false
      composerEl?.focus()
    }
  }

  function onComposerKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  // ── live stream ─────────────────────────────────────────────────────────
  let source: EventSource | null = null
  let heartbeat: ReturnType<typeof setInterval> | undefined

  type MessageFrame = { action: 'created' | 'edited' | 'deleted'; message: MessageView; unread: number }

  async function onMessageFrame(f: MessageFrame) {
    const cid = f.message.conversationId
    if (!conversations.some((c) => c.id === cid)) await refreshConversations()
    if (cid === selectedId) {
      const stick = nearBottom()
      messages = mergeMessages(messages, [f.message])
      if (f.action === 'created' && f.message.authorId !== data.me && document.visibilityState === 'visible') {
        void markRead(cid)
      }
      await tick()
      if (stick) scrollToBottom()
    } else {
      conversations = setUnread(conversations, cid, f.unread)
    }
  }

  async function refreshConversations() {
    const fresh = await api<{ conversations: ConversationView[] }>('/api/messages/conversations')
    conversations = fresh.conversations
  }

  function connect() {
    source = new EventSource(`/api/messages/stream?after=${data.cursor}`)
    source.onopen = () => (live = 'live')
    source.onerror = () => (live = 'reconnecting')
    source.addEventListener('message', (e) => void onMessageFrame(JSON.parse((e as MessageEvent).data)))
    source.addEventListener('conversation', (e) => {
      const { conversation } = JSON.parse((e as MessageEvent).data) as { conversation: ConversationView }
      conversations = upsertConversation(conversations, conversation)
    })
    source.addEventListener('read', (e) => {
      const { conversationId, unread } = JSON.parse((e as MessageEvent).data) as {
        conversationId: string
        unread: number
      }
      conversations = setUnread(conversations, conversationId, unread)
    })
  }

  async function reportViewing() {
    const conversationId = document.visibilityState === 'visible' ? selectedId : null
    await fetch('/api/messages/viewing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId }),
      keepalive: true,
    }).catch(() => {})
  }

  function onVisibility() {
    void reportViewing()
    if (document.visibilityState === 'visible' && selectedId && selected && selected.unread > 0) {
      void markRead(selectedId)
    }
  }

  onMount(() => {
    connect()
    heartbeat = setInterval(() => void reportViewing(), 20_000)
    document.addEventListener('visibilitychange', onVisibility)
    const initial = page.url.searchParams.get('c')
    if (initial && conversations.some((c) => c.id === initial)) void openConversation(initial, false)
  })

  onDestroy(() => {
    source?.close()
    if (heartbeat) clearInterval(heartbeat)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
      selectedId = null
      void reportViewing()
    }
  })

  // ── new channel / new message dialogs ───────────────────────────────────
  let channelOpen = $state(false)
  let channelName = $state('')
  let channelTopic = $state('')
  let channelPrivate = $state(false)
  let channelPeople = $state<string[]>([])
  let channelGroups = $state<string[]>([])
  let channelError = $state<string | null>(null)

  function openNewChannel() {
    channelName = ''
    channelTopic = ''
    channelPrivate = false
    channelPeople = []
    channelGroups = []
    channelError = null
    channelOpen = true
  }

  async function createChannel(e: SubmitEvent) {
    e.preventDefault()
    channelError = null
    try {
      const { conversation } = await api<{ conversation: ConversationView }>('/api/messages/channels', {
        method: 'POST',
        body: JSON.stringify({
          name: channelName,
          topic: channelTopic,
          private: channelPrivate,
          userIds: channelPrivate ? channelPeople : [],
          groupIds: channelPrivate ? channelGroups : [],
        }),
      })
      conversations = upsertConversation(conversations, conversation)
      channelOpen = false
      void openConversation(conversation.id)
    } catch (err) {
      channelError = err instanceof Error ? err.message : String(err)
    }
  }

  let dmOpen = $state(false)
  let dmPeople = $state<string[]>([])
  let dmFilter = $state('')
  let dmError = $state<string | null>(null)
  const dmCandidates = $derived(
    others.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(dmFilter.trim().toLowerCase())),
  )

  function openNewDm() {
    dmPeople = []
    dmFilter = ''
    dmError = null
    dmOpen = true
  }

  async function startDm(e: SubmitEvent) {
    e.preventDefault()
    dmError = null
    try {
      const { conversation } = await api<{ conversation: ConversationView }>('/api/messages/dms', {
        method: 'POST',
        body: JSON.stringify({ userIds: dmPeople }),
      })
      conversations = upsertConversation(conversations, conversation)
      dmOpen = false
      void openConversation(conversation.id)
    } catch (err) {
      dmError = err instanceof Error ? err.message : String(err)
    }
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
  }

  const personLabel = (p: { name: string; email: string }) => p.name.trim() || p.email
</script>

<svelte:head><title>{docTitle('Messages')}</title></svelte:head>

{#snippet conversationRow(c: ConversationView)}
  <li>
    <button
      type="button"
      class="flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60 {c.id ===
      selectedId
        ? 'bg-foreground/[0.06] font-medium'
        : ''} {c.unread > 0 ? 'font-semibold' : ''}"
      aria-current={c.id === selectedId ? 'true' : undefined}
      data-testid="messages-conversation"
      data-title={c.title}
      onclick={() => openConversation(c.id)}
    >
      {#if c.kind === 'channel'}
        {#if c.private}
          <Lock class="size-3.5 shrink-0 text-muted-foreground" aria-label="Private channel" />
        {:else}
          <Hash class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/if}
      {:else}
        <span
          class="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
          aria-hidden="true">{c.title.slice(0, 1).toUpperCase()}</span
        >
      {/if}
      <span class="min-w-0 flex-1 truncate">{c.title}</span>
      {#if c.unread > 0}
        <span
          class="min-w-5 shrink-0 rounded-full bg-primary px-1.5 text-center text-[11px] leading-5 font-semibold text-primary-foreground tabular-nums"
          data-testid="messages-unread"
          aria-label="{c.unread} unread">{c.unread > 99 ? '99+' : c.unread}</span
        >
      {/if}
    </button>
  </li>
{/snippet}

<PageFrame>
  <PageHeader title="Messages" description="Talk with your team in channels and direct messages.">
    {#snippet actions()}
      <span
        class="text-xs text-muted-foreground"
        data-testid="messages-live"
        data-state={live}
        title="Live updates">{live === 'live' ? '● Live' : live === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span
      >
    {/snippet}
  </PageHeader>

  <div
    class="mt-6 grid h-[calc(100dvh-14rem)] min-h-[26rem] overflow-hidden rounded-lg border border-border md:grid-cols-[15rem_1fr]"
    data-testid="messages-panel"
  >
    <!-- Conversation list (on phones: the whole panel until one is open) -->
    <nav
      class="min-h-0 flex-col overflow-y-auto border-border p-2 md:flex md:border-r {selectedId
        ? 'hidden'
        : 'flex'}"
      aria-label="Conversations"
      data-testid="messages-list"
    >
      <div class="flex items-center justify-between px-2.5 pt-1 pb-1">
        <h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Channels</h2>
        <button
          type="button"
          class="rounded p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="New channel"
          title="New channel"
          data-testid="messages-new-channel"
          onclick={openNewChannel}><Plus class="size-4" /></button
        >
      </div>
      {#if channels.length === 0}
        <p class="px-2.5 py-1 text-xs text-muted-foreground">No channels yet.</p>
      {/if}
      <ul class="flex flex-col gap-0.5">
        {#each channels as c (c.id)}{@render conversationRow(c)}{/each}
      </ul>

      <div class="mt-4 flex items-center justify-between px-2.5 pt-1 pb-1">
        <h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Direct messages</h2>
        <button
          type="button"
          class="rounded p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="New message"
          title="New message"
          data-testid="messages-new-dm"
          onclick={openNewDm}><Plus class="size-4" /></button
        >
      </div>
      {#if dms.length === 0}
        <p class="px-2.5 py-1 text-xs text-muted-foreground">No direct messages yet.</p>
      {/if}
      <ul class="flex flex-col gap-0.5">
        {#each dms as c (c.id)}{@render conversationRow(c)}{/each}
      </ul>
    </nav>

    <!-- Conversation -->
    <section
      class="min-h-0 min-w-0 flex-col md:flex {selectedId ? 'flex' : 'hidden'}"
      aria-label="Conversation"
      data-testid="messages-conversation-view"
    >
      {#if selected}
        <header class="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
          <button
            type="button"
            class="rounded p-1 text-muted-foreground hover:bg-foreground/[0.06] md:hidden"
            aria-label="Back to conversations"
            data-testid="messages-back"
            onclick={closeConversation}><ArrowLeft class="size-4" /></button
          >
          <div class="min-w-0">
            <h2 class="flex items-center gap-1.5 truncate text-sm font-semibold" data-testid="messages-title">
              {#if selected.kind === 'channel'}
                {#if selected.private}<Lock class="size-3.5" aria-label="Private" />{:else}<Hash
                    class="size-3.5"
                    aria-hidden="true"
                  />{/if}
              {/if}
              {selected.title}
            </h2>
            {#if selected.topic}
              <p class="truncate text-xs text-muted-foreground">{selected.topic}</p>
            {/if}
          </div>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4" bind:this={listEl} data-testid="messages-log">
          {#if hasMore}
            <div class="mb-3 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={loadingEarlier}
                onclick={loadEarlier}
                data-testid="messages-load-earlier">{loadingEarlier ? 'Loading…' : 'Load earlier'}</Button
              >
            </div>
          {/if}
          {#if messages.length === 0}
            <p class="py-10 text-center text-sm text-muted-foreground" data-testid="messages-empty">
              No messages yet. Say hello.
            </p>
          {/if}
          {#each days as day (day.key)}
            <div class="my-3 flex items-center gap-3" data-testid="messages-day">
              <span class="h-px flex-1 bg-border"></span>
              <span class="text-[11px] font-medium text-muted-foreground">{day.label}</span>
              <span class="h-px flex-1 bg-border"></span>
            </div>
            {#each day.messages as m, i (m.id)}
              {@const run = continuesRun(day.messages[i - 1], m)}
              <article class="group flex gap-2.5 {run ? 'mt-0.5' : 'mt-3'}" data-testid="messages-item">
                <div class="w-8 shrink-0">
                  {#if !run}
                    <span
                      class="grid size-8 place-items-center rounded-full bg-foreground/[0.07] text-xs font-semibold"
                      aria-hidden="true">{m.authorName.slice(0, 1).toUpperCase()}</span
                    >
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  {#if !run}
                    <p class="flex items-baseline gap-2">
                      <span class="text-sm font-semibold" data-testid="messages-author">{m.authorName}</span>
                      <time class="text-[11px] text-muted-foreground" datetime={m.createdAt} title={fullFmt.format(new Date(m.createdAt))}
                        >{timeFmt.format(new Date(m.createdAt))}</time
                      >
                    </p>
                  {/if}
                  {#if m.deleted}
                    <p class="text-sm text-muted-foreground italic">This message was deleted.</p>
                  {:else}
                    <div class="message-body text-sm leading-relaxed break-words" data-testid="messages-body">
                      <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by renderMessageMarkdown (DOMPurify allowlist) -->
                      {@html renderMessageMarkdown(m.body)}
                    </div>
                    {#if m.editedAt}<span class="text-[11px] text-muted-foreground">(edited)</span>{/if}
                  {/if}
                </div>
              </article>
            {/each}
          {/each}
        </div>

        <form
          class="border-t border-border p-2.5 sm:p-3"
          onsubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          {#if errorText}
            <p class="mb-2 text-xs text-destructive" role="alert" data-testid="messages-error">{errorText}</p>
          {/if}
          <div class="flex items-end gap-2">
            <textarea
              bind:this={composerEl}
              bind:value={draft}
              rows="1"
              class="max-h-40 min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              placeholder={selected.kind === 'channel' ? `Message #${selected.title}` : `Message ${selected.title}`}
              aria-label="Message"
              data-testid="messages-composer"
              onkeydown={onComposerKey}
            ></textarea>
            <Button type="submit" disabled={sending || !draft.trim()} data-testid="messages-send">Send</Button>
          </div>
          <p class="mt-1 hidden text-[11px] text-muted-foreground sm:block">
            Enter to send · Shift+Enter for a new line · Markdown works
          </p>
        </form>
      {:else}
        <div class="grid flex-1 place-items-center p-8 text-center">
          <div>
            <p class="text-sm font-medium">Pick a conversation</p>
            <p class="mt-1 text-sm text-muted-foreground">Or start one with “New channel” or “New message”.</p>
          </div>
        </div>
      {/if}
    </section>
  </div>
</PageFrame>

<Dialog.Root bind:open={channelOpen}>
  <Dialog.Content class="max-w-md">
    <form onsubmit={createChannel} class="flex flex-col gap-4" data-testid="messages-channel-form">
      <Dialog.Header>
        <Dialog.Title>New channel</Dialog.Title>
        <Dialog.Description>A place for a topic or a team.</Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-1.5">
        <Label for="channel-name">Name</Label>
        <Input id="channel-name" bind:value={channelName} placeholder="general" required maxlength={80} />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="channel-topic">Topic (optional)</Label>
        <Input id="channel-topic" bind:value={channelTopic} placeholder="What it's about" />
      </div>
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1 text-sm font-medium">Who can see it</legend>
        <label class="flex items-start gap-2 text-sm">
          <input type="radio" name="visibility" checked={!channelPrivate} onchange={() => (channelPrivate = false)} data-testid="channel-public" />
          <span><span class="font-medium">Everyone</span> — anyone in the company can read and post.</span>
        </label>
        <label class="flex items-start gap-2 text-sm">
          <input type="radio" name="visibility" checked={channelPrivate} onchange={() => (channelPrivate = true)} data-testid="channel-private" />
          <span><span class="font-medium">Private</span> — only the people and groups you invite.</span>
        </label>
      </fieldset>
      {#if channelPrivate}
        <div class="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2" data-testid="channel-invite">
          {#if data.groups.length > 0}
            <p class="text-xs font-medium text-muted-foreground">Groups</p>
            {#each data.groups as g (g.id)}
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={channelGroups.includes(g.id)} onchange={() => (channelGroups = toggle(channelGroups, g.id))} />
                {g.name}
              </label>
            {/each}
          {/if}
          <p class="text-xs font-medium text-muted-foreground">People</p>
          {#if others.length === 0}<p class="text-xs text-muted-foreground">No one else in the company yet.</p>{/if}
          {#each others as p (p.id)}
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={channelPeople.includes(p.id)} onchange={() => (channelPeople = toggle(channelPeople, p.id))} />
              <span class="truncate">{personLabel(p)}</span>
              <span class="truncate text-xs text-muted-foreground">{p.email}</span>
            </label>
          {/each}
        </div>
      {/if}
      {#if channelError}<p class="text-sm text-destructive" role="alert">{channelError}</p>{/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (channelOpen = false)}>Cancel</Button>
        <Button type="submit" data-testid="channel-create">Create channel</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={dmOpen}>
  <Dialog.Content class="max-w-md">
    <form onsubmit={startDm} class="flex flex-col gap-4" data-testid="messages-dm-form">
      <Dialog.Header>
        <Dialog.Title>New message</Dialog.Title>
        <Dialog.Description>Pick one person, or a few for a small group.</Dialog.Description>
      </Dialog.Header>
      <Input bind:value={dmFilter} placeholder="Search people" aria-label="Search people" />
      <div class="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2" data-testid="dm-people">
        {#if dmCandidates.length === 0}<p class="text-xs text-muted-foreground">No one found.</p>{/if}
        {#each dmCandidates as p (p.id)}
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dmPeople.includes(p.id)} onchange={() => (dmPeople = toggle(dmPeople, p.id))} data-testid="dm-person" data-email={p.email} />
            <span class="truncate">{personLabel(p)}</span>
            <span class="truncate text-xs text-muted-foreground">{p.email}</span>
          </label>
        {/each}
      </div>
      {#if dmError}<p class="text-sm text-destructive" role="alert">{dmError}</p>{/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (dmOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={dmPeople.length === 0} data-testid="dm-start">Start</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<style>
  .message-body :global(p) {
    margin: 0;
  }
  .message-body :global(p + p),
  .message-body :global(ul),
  .message-body :global(ol),
  .message-body :global(pre),
  .message-body :global(blockquote) {
    margin-top: 0.4rem;
  }
  .message-body :global(ul) {
    list-style: disc;
    padding-left: 1.25rem;
  }
  .message-body :global(ol) {
    list-style: decimal;
    padding-left: 1.25rem;
  }
  .message-body :global(code) {
    border-radius: 0.25rem;
    background: color-mix(in oklab, currentColor 8%, transparent);
    padding: 0.05rem 0.3rem;
    font-size: 0.85em;
  }
  .message-body :global(pre) {
    overflow-x: auto;
    border-radius: 0.375rem;
    background: color-mix(in oklab, currentColor 6%, transparent);
    padding: 0.5rem 0.75rem;
  }
  .message-body :global(pre code) {
    background: none;
    padding: 0;
  }
  .message-body :global(blockquote) {
    border-left: 2px solid var(--border);
    padding-left: 0.75rem;
    color: var(--muted-foreground);
  }
  .message-body :global(a) {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
