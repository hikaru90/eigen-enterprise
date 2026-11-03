<script lang="ts">
  import type { PageData } from './$types'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import FileText from '@lucide/svelte/icons/file-text'
  import Hash from '@lucide/svelte/icons/hash'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Lock from '@lucide/svelte/icons/lock'
  import MessageSquare from '@lucide/svelte/icons/message-square'
  import Paperclip from '@lucide/svelte/icons/paperclip'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Plus from '@lucide/svelte/icons/plus'
  import SmilePlus from '@lucide/svelte/icons/smile-plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import X from '@lucide/svelte/icons/x'
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
    applyFrame,
    continuesRun,
    formatSize,
    groupByDay,
    mergeMessages,
    reactedBy,
    reactionTitle,
    setUnread,
    upsertConversation,
    type AttachmentView,
    type ConversationView,
    type MessageFrame,
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
  let fileInput = $state<HTMLInputElement | null>(null)

  // Threads, reactions, edit/delete, attachments (C2).
  let thread = $state<{ parent: MessageView; replies: MessageView[] } | null>(null)
  let threadDraft = $state('')
  let threadSending = $state(false)
  let threadError = $state<string | null>(null)
  let threadListEl = $state<HTMLDivElement | null>(null)
  let editingId = $state<string | null>(null)
  let editDraft = $state('')
  let pickerFor = $state<string | null>(null)
  let deleteTarget = $state<MessageView | null>(null)
  let deleteError = $state<string | null>(null)
  type PendingFile = { key: number; name: string; status: 'uploading' | 'ready'; file?: AttachmentView }
  let pendingFiles = $state<PendingFile[]>([])
  let dragging = $state(false)
  let nextKey = 0

  const selected = $derived(conversations.find((c) => c.id === selectedId) ?? null)
  const channels = $derived(conversations.filter((c) => c.kind === 'channel'))
  const dms = $derived(conversations.filter((c) => c.kind === 'dm'))
  const days = $derived(groupByDay(messages))
  const others = $derived(data.people.filter((p) => p.id !== data.me))
  const uploading = $derived(pendingFiles.some((f) => f.status === 'uploading'))
  const readyFiles = $derived(pendingFiles.filter((f) => f.status === 'ready' && f.file).map((f) => f.file as AttachmentView))

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

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

  function scrollToBottom() {
    if (listEl) listEl.scrollTop = listEl.scrollHeight
  }
  const nearBottom = () => !listEl || listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120

  function setUrl(conversationId: string | null, threadId: string | null) {
    if (!conversationId) return replaceState(resolve('/messages'), {})
    const t = threadId ? `&t=${encodeURIComponent(threadId)}` : ''
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() plus a query string
    replaceState(`${resolve('/messages')}?c=${encodeURIComponent(conversationId)}${t}`, {})
  }

  // ── conversation selection ──────────────────────────────────────────────
  async function openConversation(id: string, updateUrl = true) {
    selectedId = id
    messages = []
    hasMore = false
    errorText = null
    thread = null
    editingId = null
    pickerFor = null
    pendingFiles = []
    // The deep link (?c=…) already carries the id on mount, before the router is up.
    if (updateUrl) setUrl(id, null)
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
      errorText = message(err)
    }
  }

  function closeConversation() {
    selectedId = null
    thread = null
    setUrl(null, null)
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
      errorText = message(err)
    } finally {
      loadingEarlier = false
    }
  }

  // ── composer + attachments ──────────────────────────────────────────────
  async function send() {
    const body = draft
    if (!selectedId || sending || uploading) return
    if (!body.trim() && readyFiles.length === 0) return
    sending = true
    errorText = null
    try {
      const { message: posted } = await api<{ message: MessageView }>(
        `/api/messages/conversations/${selectedId}/messages`,
        { method: 'POST', body: JSON.stringify({ body, attachmentIds: readyFiles.map((f) => f.fileId) }) },
      )
      draft = ''
      pendingFiles = []
      messages = mergeMessages(messages, [posted])
      await tick()
      scrollToBottom()
    } catch (err) {
      errorText = message(err)
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

  /** Uploads into the conversation's Drive folder; each file succeeds or fails on its own. */
  async function attach(files: File[]) {
    const id = selectedId
    if (!id || files.length === 0) return
    errorText = null
    const keys = files.map((f) => {
      const key = ++nextKey
      pendingFiles = [...pendingFiles, { key, name: f.name, status: 'uploading' }]
      return key
    })
    const form = new FormData()
    for (const f of files) form.append('file', f)
    try {
      const res = await fetch(`/api/messages/conversations/${id}/attachments`, { method: 'POST', body: form })
      const body = (await res.json().catch(() => ({}))) as { uploaded?: AttachmentView[]; errors?: string[]; error?: string }
      if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`)
      if (selectedId !== id) return
      const uploaded = [...(body.uploaded ?? [])]
      pendingFiles = pendingFiles.flatMap((p) => {
        if (!keys.includes(p.key)) return [p]
        const i = uploaded.findIndex((u) => u.name === p.name)
        if (i < 0) return []
        const [file] = uploaded.splice(i, 1)
        return [{ ...p, status: 'ready' as const, file }]
      })
      if (body.errors?.length) errorText = body.errors.join(' ')
    } catch (err) {
      pendingFiles = pendingFiles.filter((p) => !keys.includes(p.key))
      errorText = message(err)
    }
  }

  function onPickFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    void attach([...(input.files ?? [])])
    input.value = ''
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    void attach([...(e.dataTransfer?.files ?? [])])
  }

  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])]
    if (files.length === 0) return
    e.preventDefault()
    void attach(files)
  }

  // ── threads ─────────────────────────────────────────────────────────────
  async function openThread(parentId: string, updateUrl = true) {
    threadError = null
    threadDraft = ''
    try {
      const t = await api<{ parent: MessageView; replies: MessageView[] }>(`/api/messages/messages/${parentId}/thread`)
      thread = t
      if (updateUrl) setUrl(selectedId, parentId)
      await tick()
      if (threadListEl) threadListEl.scrollTop = threadListEl.scrollHeight
    } catch (err) {
      errorText = message(err)
    }
  }

  function closeThread() {
    thread = null
    setUrl(selectedId, null)
  }

  async function sendReply() {
    if (!thread || !selectedId || !threadDraft.trim() || threadSending) return
    threadSending = true
    threadError = null
    const parentId = thread.parent.id
    try {
      const { message: reply, parent } = await api<{ message: MessageView; parent: MessageView | null }>(
        `/api/messages/conversations/${selectedId}/messages`,
        { method: 'POST', body: JSON.stringify({ body: threadDraft, parentId }) },
      )
      threadDraft = ''
      applyLocal({ action: 'created', message: reply, parent, unread: 0 })
      await tick()
      if (threadListEl) threadListEl.scrollTop = threadListEl.scrollHeight
    } catch (err) {
      threadError = message(err)
    } finally {
      threadSending = false
    }
  }

  function onReplyKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void sendReply()
    }
  }

  /** Folds a frame (live or our own) into the log, the open thread and its parent. */
  function applyLocal(f: MessageFrame) {
    const t = thread
    const out = applyFrame(messages, t ? { parentId: t.parent.id, replies: t.replies } : null, f)
    messages = out.log
    if (t) {
      let parent = t.parent
      if (f.message.id === parent.id) parent = f.message
      if (f.parent && f.parent.id === parent.id) parent = f.parent
      thread = { parent, replies: out.replies ?? t.replies }
    }
  }

  // ── reactions, edit, delete ─────────────────────────────────────────────
  async function react(m: MessageView, emoji: string) {
    pickerFor = null
    try {
      const { message: updated } = await api<{ message: MessageView }>(`/api/messages/messages/${m.id}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      })
      applyLocal({ action: 'reacted', message: updated, parent: null, unread: 0 })
    } catch (err) {
      errorText = message(err)
    }
  }

  function startEdit(m: MessageView) {
    editingId = m.id
    editDraft = m.body
    pickerFor = null
  }

  async function saveEdit(m: MessageView) {
    const body = editDraft
    try {
      await api(`/api/messages/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
      applyLocal({ action: 'edited', message: { ...m, body: body.trim(), editedAt: new Date().toISOString() }, parent: null, unread: 0 })
      editingId = null
    } catch (err) {
      errorText = message(err)
    }
  }

  function onEditKey(e: KeyboardEvent, m: MessageView) {
    if (e.key === 'Escape') {
      e.preventDefault()
      editingId = null
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void saveEdit(m)
    }
  }

  async function confirmDelete() {
    const m = deleteTarget
    if (!m) return
    deleteError = null
    try {
      await api(`/api/messages/messages/${m.id}`, { method: 'DELETE' })
      applyLocal({ action: 'deleted', message: { ...m, deleted: true, body: '', reactions: [], attachments: [] }, parent: null, unread: 0 })
      deleteTarget = null
    } catch (err) {
      deleteError = message(err)
    }
  }

  const canEdit = (m: MessageView) => !m.deleted && m.authorId === data.me
  const canDelete = (m: MessageView) =>
    !m.deleted && (m.authorId === data.me || (data.moderator && selected?.kind === 'channel'))

  // ── live stream ─────────────────────────────────────────────────────────
  let source: EventSource | null = null
  let heartbeat: ReturnType<typeof setInterval> | undefined

  async function onMessageFrame(f: MessageFrame) {
    const cid = f.message.conversationId
    if (!conversations.some((c) => c.id === cid)) await refreshConversations()
    if (cid === selectedId) {
      const stick = nearBottom()
      applyLocal(f)
      if (f.action === 'created' && f.message.authorId !== data.me && document.visibilityState === 'visible') {
        if (f.unread > 0) void markRead(cid)
      }
      await tick()
      if (stick && f.message.parentId === null) scrollToBottom()
      if (thread && f.message.parentId === thread.parent.id && threadListEl) threadListEl.scrollTop = threadListEl.scrollHeight
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
    const initialThread = page.url.searchParams.get('t')
    if (initial && conversations.some((c) => c.id === initial)) {
      void openConversation(initial, false).then(() => {
        if (initialThread) void openThread(initialThread, false)
      })
    }
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

{#snippet attachmentList(files: AttachmentView[])}
  {#if files.length > 0}
    <div class="mt-1.5 flex flex-wrap gap-2" data-testid="messages-attachments">
      {#each files as f (f.fileId)}
        {#if f.image}
          <a
            href={resolve(`/drive/file/${f.fileId}`)}
            class="block overflow-hidden rounded-md border border-border"
            title={f.name}
            data-testid="messages-attachment-image"
            data-name={f.name}
          >
            <img
              src={`/api/drive/files/${encodeURIComponent(f.fileId)}/content`}
              alt={f.name}
              loading="lazy"
              class="block max-h-48 max-w-64 object-cover"
            />
          </a>
        {:else}
          <a
            href={resolve(`/drive/file/${f.fileId}`)}
            class="flex max-w-64 min-w-0 items-center gap-2.5 rounded-md border border-border px-3 py-2 hover:bg-foreground/[0.04]"
            data-testid="messages-attachment-file"
            data-name={f.name}
          >
            <FileText class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium">{f.name}</span>
              <span class="block text-[11px] text-muted-foreground">{formatSize(f.size)}</span>
            </span>
          </a>
        {/if}
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet messageItem(m: MessageView, run: boolean, inThread: boolean)}
  <article
    class="group relative flex gap-2.5 rounded-md px-1 {run ? 'mt-0.5' : 'mt-3'} hover:bg-foreground/[0.02]"
    data-testid={inThread ? 'thread-item' : 'messages-item'}
    data-id={m.id}
  >
    <div class="w-8 shrink-0">
      {#if !run}
        <span class="grid size-8 place-items-center rounded-full bg-foreground/[0.07] text-xs font-semibold" aria-hidden="true"
          >{m.authorName.slice(0, 1).toUpperCase()}</span
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
        <p class="text-sm text-muted-foreground italic" data-testid="messages-deleted">Message deleted</p>
      {:else if editingId === m.id}
        <div class="mt-0.5 flex flex-col gap-1.5" data-testid="messages-edit">
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            bind:value={editDraft}
            rows="2"
            autofocus
            class="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label="Edit message"
            data-testid="messages-edit-input"
            onkeydown={(e) => onEditKey(e, m)}
          ></textarea>
          <div class="flex items-center gap-2">
            <Button size="sm" onclick={() => saveEdit(m)} data-testid="messages-edit-save">Save</Button>
            <Button size="sm" variant="outline" onclick={() => (editingId = null)}>Cancel</Button>
            <span class="text-[11px] text-muted-foreground">Enter to save · Esc to cancel</span>
          </div>
        </div>
      {:else}
        {#if m.body}
          <div class="message-body text-sm leading-relaxed break-words" data-testid="messages-body">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by renderMessageMarkdown (DOMPurify allowlist) -->
            {@html renderMessageMarkdown(m.body)}
          </div>
        {/if}
        {#if m.editedAt}<span class="text-[11px] text-muted-foreground" data-testid="messages-edited">(edited)</span>{/if}
        {@render attachmentList(m.attachments)}
      {/if}

      {#if !m.deleted && m.reactions.length > 0}
        <div class="mt-1 flex flex-wrap gap-1" data-testid="messages-reactions">
          {#each m.reactions as r (r.emoji)}
            {@const mine = reactedBy(r, data.me)}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs tabular-nums {mine
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-border hover:bg-foreground/[0.04]'}"
              title={reactionTitle(r)}
              aria-label="{r.emoji} {r.userIds.length}: {reactionTitle(r)}"
              aria-pressed={mine}
              data-testid="messages-reaction"
              data-emoji={r.emoji}
              data-count={r.userIds.length}
              onclick={() => react(m, r.emoji)}><span aria-hidden="true">{r.emoji}</span>{r.userIds.length}</button
            >
          {/each}
        </div>
      {/if}

      {#if !inThread && m.replyCount > 0}
        <button
          type="button"
          class="mt-1 inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-primary hover:bg-primary/10"
          data-testid="messages-thread-link"
          data-count={m.replyCount}
          onclick={() => openThread(m.id)}
        >
          <MessageSquare class="size-3.5" aria-hidden="true" />
          {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}
          {#if m.lastReplyAt}<span class="font-normal text-muted-foreground">· last {timeFmt.format(new Date(m.lastReplyAt))}</span>{/if}
        </button>
      {/if}
    </div>

    {#if !m.deleted && editingId !== m.id}
      <div
        class="absolute -top-3 right-1 hidden items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-sm group-hover:flex group-focus-within:flex {pickerFor ===
        m.id
          ? '!flex'
          : ''}"
        data-testid="messages-actions"
      >
        <button
          type="button"
          class="rounded p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Add reaction"
          title="Add reaction"
          data-testid="messages-react"
          onclick={() => (pickerFor = pickerFor === m.id ? null : m.id)}><SmilePlus class="size-4" /></button
        >
        {#if !inThread}
          <button
            type="button"
            class="rounded p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Reply in thread"
            title="Reply in thread"
            data-testid="messages-reply"
            onclick={() => openThread(m.id)}><MessageSquare class="size-4" /></button
          >
        {/if}
        {#if canEdit(m)}
          <button
            type="button"
            class="rounded p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Edit message"
            title="Edit"
            data-testid="messages-edit-start"
            onclick={() => startEdit(m)}><Pencil class="size-4" /></button
          >
        {/if}
        {#if canDelete(m)}
          <button
            type="button"
            class="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label="Delete message"
            title={m.authorId === data.me ? 'Delete' : 'Delete (moderation)'}
            data-testid="messages-delete"
            onclick={() => {
              deleteError = null
              deleteTarget = m
            }}><Trash2 class="size-4" /></button
          >
        {/if}
        {#if pickerFor === m.id}
          <div
            class="absolute top-full right-0 z-20 mt-1 grid w-max grid-cols-5 gap-0.5 rounded-md border border-border bg-popover p-1 shadow-md"
            role="menu"
            aria-label="Pick a reaction"
            data-testid="messages-picker"
          >
            {#each data.reactionEmoji as emoji (emoji)}
              <button
                type="button"
                role="menuitem"
                class="grid size-8 place-items-center rounded text-base hover:bg-foreground/[0.06]"
                aria-label="React {emoji}"
                data-testid="messages-picker-emoji"
                data-emoji={emoji}
                onclick={() => react(m, emoji)}>{emoji}</button
              >
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </article>
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
    class="mt-6 grid h-[calc(100dvh-14rem)] min-h-[26rem] overflow-hidden rounded-lg border border-border md:grid-cols-[15rem_1fr] {thread ? 'lg:grid-cols-[15rem_1fr_22rem]' : ''}"
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

    <!-- Conversation (hidden below lg while a thread is open: the thread takes its place) -->
    <section
      class="min-h-0 min-w-0 flex-col {thread ? 'hidden lg:flex' : selectedId ? 'flex' : 'hidden md:flex'}"
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
              {@render messageItem(m, continuesRun(day.messages[i - 1], m) && m.replyCount === 0 && (day.messages[i - 1]?.replyCount ?? 0) === 0, false)}
            {/each}
          {/each}
        </div>

        <form
          class="border-t border-border p-2.5 sm:p-3 {dragging ? 'bg-primary/5 ring-2 ring-primary/40 ring-inset' : ''}"
          data-testid="messages-composer-form"
          onsubmit={(e) => {
            e.preventDefault()
            void send()
          }}
          ondragover={(e) => {
            if (e.dataTransfer?.types.includes('Files')) {
              e.preventDefault()
              dragging = true
            }
          }}
          ondragleave={() => (dragging = false)}
          ondrop={onDrop}
        >
          {#if errorText}
            <p class="mb-2 text-xs text-destructive" role="alert" data-testid="messages-error">{errorText}</p>
          {/if}
          {#if pendingFiles.length > 0}
            <ul class="mb-2 flex flex-wrap gap-1.5" data-testid="messages-pending">
              {#each pendingFiles as p (p.key)}
                <li
                  class="flex max-w-56 items-center gap-1.5 rounded-md border border-border bg-foreground/[0.03] py-1 pr-1 pl-2 text-xs"
                  data-testid="messages-pending-file"
                  data-status={p.status}
                  data-name={p.name}
                >
                  {#if p.status === 'uploading'}<LoaderCircle class="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Uploading" />{:else}<Paperclip
                      class="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />{/if}
                  <span class="truncate">{p.name}</span>
                  {#if p.file}<span class="shrink-0 text-muted-foreground">{formatSize(p.file.size)}</span>{/if}
                  <button
                    type="button"
                    class="rounded p-0.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                    aria-label="Remove {p.name}"
                    onclick={() => (pendingFiles = pendingFiles.filter((x) => x.key !== p.key))}><X class="size-3.5" /></button
                  >
                </li>
              {/each}
            </ul>
          {/if}
          <div class="flex items-end gap-2">
            <input
              bind:this={fileInput}
              type="file"
              multiple
              class="hidden"
              data-testid="messages-file-input"
              onchange={onPickFiles}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Attach files"
              title="Attach files (they’re saved to the Drive)"
              data-testid="messages-attach"
              onclick={() => fileInput?.click()}><Paperclip class="size-4" /></Button
            >
            <textarea
              bind:this={composerEl}
              bind:value={draft}
              rows="1"
              class="max-h-40 min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              placeholder={selected.kind === 'channel' ? `Message #${selected.title}` : `Message ${selected.title}`}
              aria-label="Message"
              data-testid="messages-composer"
              onkeydown={onComposerKey}
              onpaste={onPaste}
            ></textarea>
            <Button
              type="submit"
              disabled={sending || uploading || (!draft.trim() && readyFiles.length === 0)}
              data-testid="messages-send">Send</Button
            >
          </div>
          <p class="mt-1 hidden text-[11px] text-muted-foreground sm:block">
            Enter to send · Shift+Enter for a new line · Markdown works · drop or paste files to attach
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

    {#if thread && selected}
      <aside
        class="flex min-h-0 min-w-0 flex-col border-border md:border-l"
        aria-label="Thread"
        data-testid="messages-thread"
      >
        <header class="flex items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
          <div class="min-w-0 flex-1">
            <h2 class="text-sm font-semibold">Thread</h2>
            <p class="truncate text-xs text-muted-foreground">
              {selected.kind === 'channel' ? `#${selected.title}` : selected.title}
            </p>
          </div>
          <button
            type="button"
            class="rounded p-1 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Close thread"
            data-testid="messages-thread-close"
            onclick={closeThread}><X class="size-4" /></button
          >
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2 sm:px-4" bind:this={threadListEl} data-testid="thread-log">
          {@render messageItem(thread.parent, false, true)}
          <div class="my-3 flex items-center gap-3">
            <span class="text-[11px] font-medium text-muted-foreground" data-testid="thread-count"
              >{thread.replies.length === 0
                ? 'No replies yet'
                : `${thread.replies.length} ${thread.replies.length === 1 ? 'reply' : 'replies'}`}</span
            >
            <span class="h-px flex-1 bg-border"></span>
          </div>
          {#each thread.replies as r, i (r.id)}
            {@render messageItem(r, continuesRun(thread.replies[i - 1], r), true)}
          {/each}
        </div>
        <form
          class="border-t border-border p-2.5 sm:p-3"
          onsubmit={(e) => {
            e.preventDefault()
            void sendReply()
          }}
        >
          {#if threadError}
            <p class="mb-2 text-xs text-destructive" role="alert">{threadError}</p>
          {/if}
          <div class="flex items-end gap-2">
            <textarea
              bind:value={threadDraft}
              rows="1"
              class="max-h-40 min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              placeholder="Reply…"
              aria-label="Reply"
              data-testid="thread-composer"
              onkeydown={onReplyKey}
            ></textarea>
            <Button type="submit" disabled={threadSending || !threadDraft.trim()} data-testid="thread-send">Reply</Button>
          </div>
        </form>
      </aside>
    {/if}
  </div>
</PageFrame>

<Dialog.Root
  open={deleteTarget !== null}
  onOpenChange={(open) => {
    if (!open) deleteTarget = null
  }}
>
  <Dialog.Content class="max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Delete message?</Dialog.Title>
      <Dialog.Description>
        {#if deleteTarget && deleteTarget.authorId !== data.me}
          You’re deleting {deleteTarget.authorName}’s message as a moderator. Everyone will see “Message deleted”, and the
          deletion is recorded in the audit log.
        {:else}
          Everyone will see “Message deleted” in its place. This can’t be undone.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    {#if deleteError}<p class="text-sm text-destructive" role="alert">{deleteError}</p>{/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
      <Button variant="destructive" onclick={confirmDelete} data-testid="messages-delete-confirm">Delete</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

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
