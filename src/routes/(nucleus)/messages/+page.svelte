<script lang="ts">
  import type { PageData } from './$types'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Hash from '@lucide/svelte/icons/hash'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Lock from '@lucide/svelte/icons/lock'
  import Mic from '@lucide/svelte/icons/mic'
  import Paperclip from '@lucide/svelte/icons/paperclip'
  import Plus from '@lucide/svelte/icons/plus'
  import SquarePen from '@lucide/svelte/icons/square-pen'
  import Users from '@lucide/svelte/icons/users'
  import X from '@lucide/svelte/icons/x'
  import { onDestroy, onMount, tick } from 'svelte'
  import { replaceState } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import CallButton from '$lib/calls/call-button.svelte'
  import { callsClient } from '$lib/calls/client'
  import { getLiveCalls } from '$lib/calls/live-calls.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import type { ShownError } from '$lib/errors/agent-report'
  import { createDrafts } from '$lib/messages/drafts'
  import MessageComposer from '$lib/messages/message-composer.svelte'
  import MessageRow, { type RowPerson } from '$lib/messages/message-row.svelte'
  import {
    applyPresence,
    presenceLabel,
    presenceOf,
    type PresenceFrame,
    type PresenceMap,
    type PresenceView,
  } from '$lib/messages/presence'
  import PresenceDot from '$lib/messages/presence-dot.svelte'
  import PresenceSelf from '$lib/messages/presence-self.svelte'
  import type { ReplyQuote as Quote } from '$lib/messages/quote'
  import ReplyQuote from '$lib/messages/reply-quote.svelte'
  import { ResumableStream } from '$lib/messages/resumable-stream'
  import { getSelfPresence } from '$lib/messages/self-presence.svelte'
  import {
    applyFrame,
    formatSize,
    groupByDay,
    mergeMessages,
    MessagesRequestError,
    shownFailure,
    messageRows,
    quoteOf,
    setUnread,
    upsertConversation,
    type AttachmentView,
    type ConversationView,
    type MessageFrame,
    type MessageView,
  } from '$lib/messages/view'
  import { uploadVoiceRecording } from '$lib/messages/voice-upload'
  import { syncAppBadge, totalUnread } from '$lib/pwa/badge'
  import NotificationsBanner from '$lib/pwa/notifications-banner.svelte'
  import { docTitle } from '$lib/shell/title'
  import { formatVoiceTimer, type VoiceRecording } from '$lib/voice/voice-message'

  /**
   * Messages (phase-workspace C1/C2, polish-1 Slack layout): a full-bleed app
   * — the channel sidebar, the conversation (header, day-grouped log,
   * composer) and the thread pane on the right — using the whole content
   * column; each pane scrolls on its own.
   */
  let { data }: { data: PageData } = $props()

  // Calls (plan/video-calls.md §2): the header's Call / Join button reads the layout's one call feed.
  const liveCalls = getLiveCalls()
  const calls = callsClient()

  type Person = { id: string; name: string; email: string; image?: string | null }

  // Page-owned state seeded once from the load (the live stream keeps it current).
  // svelte-ignore state_referenced_locally
  let conversations = $state<ConversationView[]>(data.conversations)
  /** Every change to the list goes through here so the app-icon badge follows the unread counts. */
  function setConversations(next: ConversationView[]) {
    conversations = next
    void syncAppBadge(totalUnread(next))
  }
  let selectedId = $state<string | null>(null)
  let messages = $state<MessageView[]>([])
  let hasMore = $state(false)
  let loadingEarlier = $state(false)
  let draft = $state('')
  // Unsent text stays per conversation in this browser: restored on open, cleared on send.
  // svelte-ignore state_referenced_locally
  const drafts = createDrafts(data.me, () => localStorage)
  let sending = $state(false)
  /** A failure the page shows: the sentence, the server's agent report (if any) and what the page was doing. */
  type PageError = ShownError & { attempted: string }
  let errorText = $state<PageError | null>(null)
  let live = $state<'connecting' | 'live' | 'reconnecting'>('connecting')
  let now = $state(new Date())

  // Presence (Contribute 119f59a4): everyone's status from the live feed; mine is set by this tab's heartbeat.
  let presence = $state<PresenceMap>({})
  let presenceError = $state<ShownError | null>(null)
  let dndSaving = $state(false)
  const presenceFor = (userId: string): PresenceView => presenceOf(presence, userId)
  // My status in the main nav (Contribute e4ef6be1) hears what this page learns about me first.
  const selfPresence = getSelfPresence()
  function tellNav(people: PresenceView[]) {
    const mine = people.find((p) => p.userId === data.me)
    if (mine) selfPresence?.receive(mine)
  }

  let listEl = $state<HTMLDivElement | null>(null)
  let composerEl = $state<HTMLTextAreaElement | null>(null)
  let fileInput = $state<HTMLInputElement | null>(null)

  // Sidebar sections (collapsible).
  let channelsOpen = $state(true)
  let dmsOpen = $state(true)

  // Header: who is in the conversation.
  let members = $state<Person[] | null>(null)
  let membersError = $state<PageError | null>(null)
  let membersOpen = $state(false)

  // Threads, reactions, edit/delete, attachments (C2).
  let thread = $state<{ parent: MessageView; replies: MessageView[] } | null>(null)
  let threadDraft = $state('')
  let threadSending = $state(false)
  let threadError = $state<PageError | null>(null)
  let threadListEl = $state<HTMLDivElement | null>(null)
  let editingId = $state<string | null>(null)
  let pickerFor = $state<string | null>(null)
  let deleteTarget = $state<MessageView | null>(null)
  let deleteError = $state<PageError | null>(null)
  /** A file to send; `voiceMs` marks the dictated recording of the text (kept for playback), this long. */
  type PendingFile = {
    key: number
    name: string
    status: 'uploading' | 'ready'
    file?: AttachmentView
    voiceMs?: number
  }
  let pendingFiles = $state<PendingFile[]>([])
  let dragging = $state(false)
  let nextKey = 0

  // Quoted replies (Contribute 2a58bcc8): what the composer (or the thread's) is replying to, and the jump target.
  let replyingTo = $state<MessageView | null>(null)
  let threadReplyingTo = $state<MessageView | null>(null)
  let threadComposerEl = $state<HTMLTextAreaElement | null>(null)
  let highlightId = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  /** How far back a quote's jump pages before saying the original isn't loaded. */
  const QUOTE_JUMP_PAGES = 10

  const selected = $derived(conversations.find((c) => c.id === selectedId) ?? null)
  const channels = $derived(conversations.filter((c) => c.kind === 'channel'))
  const dms = $derived(conversations.filter((c) => c.kind === 'dm'))
  const days = $derived(groupByDay(messages, now))
  const people = $derived(data.people as Person[])
  const peopleById = $derived(new Map(people.map((p) => [p.id, p])))
  const others = $derived(people.filter((p) => p.id !== data.me))
  const myself = $derived(peopleById.get(data.me) ?? null)
  const uploading = $derived(pendingFiles.some((f) => f.status === 'uploading'))
  const readyFiles = $derived(
    pendingFiles
      .filter((f) => f.status === 'ready' && f.file && f.voiceMs === undefined)
      .map((f) => f.file as AttachmentView),
  )
  const readyVoice = $derived(
    pendingFiles.flatMap((f) =>
      f.status === 'ready' && f.file && f.voiceMs !== undefined
        ? [{ fileId: f.file.fileId, durationMs: f.voiceMs }]
        : [],
    ),
  )
  const canSend = $derived(
    !sending &&
      !uploading &&
      (draft.trim().length > 0 || readyFiles.length > 0 || readyVoice.length > 0),
  )

  const firstWord = (name: string) => name.trim().split(/\s+/)[0] ?? ''
  /** @mention highlighting: everyone's full and first names; yours marked as "me". */
  const mentions = $derived({
    names: people.flatMap((p) => [p.name, firstWord(p.name)]).filter(Boolean),
    me: (() => {
      const mine = peopleById.get(data.me)
      return mine ? [mine.name, firstWord(mine.name)] : []
    })(),
  })

  const rowPerson = (id: string): RowPerson => {
    const p = peopleById.get(id)
    return { id, name: p ? p.name.trim() || p.email : 'Former member', image: p?.image ?? null }
  }
  /** A DM's other participants (the row's avatar and the header). */
  const dmOthers = (c: ConversationView) => c.memberIds.filter((u) => u !== data.me).map(rowPerson)

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const body = (await res.json().catch(() => ({}))) as T
    if (!res.ok) throw new MessagesRequestError(body, `request failed (${res.status})`)
    return body
  }

  const failure = (err: unknown, attempted: string): PageError => ({
    ...shownFailure(err),
    attempted,
  })

  function scrollToBottom() {
    if (listEl) listEl.scrollTop = listEl.scrollHeight
  }
  const nearBottom = () =>
    !listEl || listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120

  function setUrl(conversationId: string | null, threadId: string | null) {
    if (!conversationId) return replaceState(resolve('/messages'), {})
    const t = threadId ? `&t=${encodeURIComponent(threadId)}` : ''
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() plus a query string
    replaceState(`${resolve('/messages')}?c=${encodeURIComponent(conversationId)}${t}`, {})
  }

  // ── conversation selection ──────────────────────────────────────────────
  async function openConversation(id: string, updateUrl = true) {
    selectedId = id
    draft = drafts.read(id)
    messages = []
    hasMore = false
    errorText = null
    thread = null
    editingId = null
    pickerFor = null
    pendingFiles = []
    replyingTo = null
    threadReplyingTo = null
    highlightId = null
    notice = null
    members = null
    membersError = null
    membersOpen = false
    now = new Date()
    // The deep link (?c=…) already carries the id on mount, before the router is up.
    if (updateUrl) setUrl(id, null)
    void loadMembers(id)
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
      errorText = failure(err, 'Opening a conversation in Messages')
    }
  }

  async function loadMembers(id: string) {
    try {
      const { members: list } = await api<{ members: Person[] }>(
        `/api/messages/conversations/${id}/members`,
      )
      if (selectedId === id) members = list
    } catch (err) {
      if (selectedId === id)
        membersError = failure(err, 'Loading the conversation’s members in Messages')
    }
  }

  function closeConversation() {
    selectedId = null
    thread = null
    setUrl(null, null)
    void reportViewing()
  }

  async function markRead(id: string) {
    setConversations(setUnread(conversations, id, 0))
    await api(`/api/messages/conversations/${id}/read`, { method: 'POST' }).catch(
      (err: unknown) => {
        console.error('[messages] mark read failed', err)
      },
    )
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
      errorText = failure(err, 'Loading earlier messages in Messages')
    } finally {
      loadingEarlier = false
    }
  }

  // ── composer + attachments ──────────────────────────────────────────────
  async function send() {
    const body = draft
    const id = selectedId
    if (!id || !canSend) return
    sending = true
    errorText = null
    try {
      const { message: posted } = await api<{ message: MessageView }>(
        `/api/messages/conversations/${id}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            body,
            replyToId: replyingTo?.id ?? null,
            attachmentIds: readyFiles.map((f) => f.fileId),
            voiceClips: readyVoice,
          }),
        },
      )
      drafts.clear(id)
      // Switched away while sending: that conversation's restored draft stays.
      if (selectedId === id) draft = ''
      pendingFiles = []
      replyingTo = null
      now = new Date()
      messages = mergeMessages(messages, [posted])
      await tick()
      scrollToBottom()
    } catch (err) {
      errorText = failure(err, 'Sending a message in Messages')
    } finally {
      sending = false
      composerEl?.focus()
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
      const res = await fetch(`/api/messages/conversations/${id}/attachments`, {
        method: 'POST',
        body: form,
      })
      const body = (await res.json().catch(() => ({}))) as {
        uploaded?: AttachmentView[]
        errors?: string[]
        error?: string
      }
      if (!res.ok) throw new MessagesRequestError(body, `upload failed (${res.status})`)
      if (selectedId !== id) return
      const uploaded = [...(body.uploaded ?? [])]
      pendingFiles = pendingFiles.flatMap((p) => {
        if (!keys.includes(p.key)) return [p]
        const i = uploaded.findIndex((u) => u.name === p.name)
        if (i < 0) return []
        const [file] = uploaded.splice(i, 1)
        return [{ ...p, status: 'ready' as const, file }]
      })
      if (body.errors?.length) {
        errorText = {
          error: body.errors.join(' '),
          agent: null,
          attempted: 'Uploading attachments in Messages',
        }
      }
    } catch (err) {
      pendingFiles = pendingFiles.filter((p) => !keys.includes(p.key))
      errorText = failure(err, 'Uploading attachments in Messages')
    }
  }

  /** The dictated recording of what was just appended to the draft: uploaded now, sent with the message, played above it. */
  async function attachVoice(recording: VoiceRecording) {
    const id = selectedId
    if (!id) return
    errorText = null
    const key = ++nextKey
    const voiceMs = Math.max(1, Math.round(recording.durationMs))
    pendingFiles = [...pendingFiles, { key, name: 'Voice message', status: 'uploading', voiceMs }]
    try {
      const file = await uploadVoiceRecording(id, recording.clip)
      if (selectedId !== id) return
      pendingFiles = pendingFiles.map((p) =>
        p.key === key ? { ...p, status: 'ready' as const, file } : p,
      )
    } catch (err) {
      pendingFiles = pendingFiles.filter((p) => p.key !== key)
      const shown = failure(err, 'Keeping a dictated recording as a voice message in Messages')
      errorText = {
        ...shown,
        error: `The recording could not be kept (the text is in the box): ${shown.error}`,
      }
    }
  }

  function onPickFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    void attach([...(input.files ?? [])])
    input.value = ''
  }

  function onDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      dragging = true
    }
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
    threadReplyingTo = null
    pickerFor = null
    try {
      const t = await api<{ parent: MessageView; replies: MessageView[] }>(
        `/api/messages/messages/${parentId}/thread`,
      )
      thread = t
      if (updateUrl) setUrl(selectedId, parentId)
      await tick()
      if (threadListEl) threadListEl.scrollTop = threadListEl.scrollHeight
    } catch (err) {
      errorText = failure(err, 'Opening a thread in Messages')
    }
  }

  function closeThread() {
    thread = null
    threadReplyingTo = null
    setUrl(selectedId, null)
  }

  async function sendReply() {
    if (!thread || !selectedId || !threadDraft.trim() || threadSending) return
    threadSending = true
    threadError = null
    const parentId = thread.parent.id
    try {
      const { message: reply, parent } = await api<{
        message: MessageView
        parent: MessageView | null
      }>(`/api/messages/conversations/${selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: threadDraft,
          parentId,
          replyToId: threadReplyingTo?.id ?? null,
        }),
      })
      threadDraft = ''
      threadReplyingTo = null
      now = new Date()
      applyLocal({ action: 'created', message: reply, parent, unread: 0 })
      await tick()
      if (threadListEl) threadListEl.scrollTop = threadListEl.scrollHeight
    } catch (err) {
      threadError = failure(err, 'Replying in a thread in Messages')
    } finally {
      threadSending = false
    }
  }

  /** Folds a frame (live or our own) into the log, the open thread and its parent. */
  function applyLocal(f: MessageFrame) {
    // A pending reply follows its original: edited, the preview updates; deleted, the reply is dropped.
    if (f.action === 'edited' || f.action === 'deleted') {
      const gone = f.action === 'deleted'
      if (replyingTo?.id === f.message.id) replyingTo = gone ? null : f.message
      if (threadReplyingTo?.id === f.message.id) threadReplyingTo = gone ? null : f.message
    }
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

  // ── quoted replies ──────────────────────────────────────────────────────
  /** "Reply": quote `m` in the composer of the pane it was picked in (the log's or the thread's). */
  async function startQuote(m: MessageView, where: 'log' | 'thread') {
    pickerFor = null
    notice = null
    if (where === 'thread') threadReplyingTo = m
    else replyingTo = m
    await tick()
    ;(where === 'thread' ? threadComposerEl : composerEl)?.focus()
  }

  const rowSelector = (scope: 'messages-item' | 'thread-item', id: string) =>
    `[data-testid="${scope}"][data-id="${CSS.escape(id)}"]`

  function highlight(el: HTMLElement, id: string) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.focus({ preventScroll: true })
    highlightId = id
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => (highlightId = null), 1600)
  }

  /**
   * A quote was clicked: scroll to the original and mark it briefly. A thread
   * reply opens its thread; an original further back pages in older history
   * (up to QUOTE_JUMP_PAGES) and otherwise says it isn't loaded.
   */
  async function jumpToQuote(q: Quote) {
    notice = null
    if (q.deleted) return
    if (q.parentId !== null) {
      if (thread?.parent.id !== q.parentId) await openThread(q.parentId)
      await tick()
      const el = threadListEl?.querySelector<HTMLElement>(rowSelector('thread-item', q.id))
      if (el) highlight(el, q.id)
      else notice = 'The original message is no longer in its thread.'
      return
    }
    const id = selectedId
    let pages = 0
    while (
      !messages.some((m) => m.id === q.id) &&
      hasMore &&
      pages < QUOTE_JUMP_PAGES &&
      selectedId === id
    ) {
      await loadEarlier()
      pages++
    }
    if (selectedId !== id) return
    await tick()
    const el = listEl?.querySelector<HTMLElement>(rowSelector('messages-item', q.id))
    if (el) highlight(el, q.id)
    else
      notice =
        'The original message is too far back to show here. Use "Load earlier" to go further.'
  }

  // ── reactions, edit, delete ─────────────────────────────────────────────
  async function react(m: MessageView, emoji: string) {
    pickerFor = null
    try {
      const { message: updated } = await api<{ message: MessageView }>(
        `/api/messages/messages/${m.id}/reactions`,
        {
          method: 'POST',
          body: JSON.stringify({ emoji }),
        },
      )
      applyLocal({ action: 'reacted', message: updated, parent: null, unread: 0 })
    } catch (err) {
      errorText = failure(err, 'Reacting to a message in Messages')
    }
  }

  function startEdit(m: MessageView) {
    editingId = m.id
    pickerFor = null
  }

  async function saveEdit(m: MessageView, body: string) {
    try {
      await api(`/api/messages/messages/${m.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      })
      applyLocal({
        action: 'edited',
        message: { ...m, body: body.trim(), editedAt: new Date().toISOString() },
        parent: null,
        unread: 0,
      })
      editingId = null
    } catch (err) {
      errorText = failure(err, 'Editing a message in Messages')
    }
  }

  async function confirmDelete() {
    const m = deleteTarget
    if (!m) return
    deleteError = null
    try {
      await api(`/api/messages/messages/${m.id}`, { method: 'DELETE' })
      applyLocal({
        action: 'deleted',
        message: { ...m, deleted: true, body: '', reactions: [], attachments: [], voice: [] },
        parent: null,
        unread: 0,
      })
      deleteTarget = null
    } catch (err) {
      deleteError = failure(err, 'Deleting a message in Messages')
    }
  }

  const canEdit = (m: MessageView) => !m.deleted && !m.call && m.authorId === data.me
  const canDelete = (m: MessageView) =>
    !m.deleted && (m.authorId === data.me || (data.moderator && selected?.kind === 'channel'))

  // ── live stream ─────────────────────────────────────────────────────────
  let stream: ResumableStream | null = null
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let clock: ReturnType<typeof setInterval> | undefined

  async function onMessageFrame(f: MessageFrame) {
    const cid = f.message.conversationId
    if (!conversations.some((c) => c.id === cid)) await refreshConversations()
    if (cid === selectedId) {
      const stick = nearBottom()
      now = new Date()
      applyLocal(f)
      if (
        f.action === 'created' &&
        f.message.authorId !== data.me &&
        document.visibilityState === 'visible'
      ) {
        if (f.unread > 0) void markRead(cid)
      }
      await tick()
      if (stick && f.message.parentId === null) scrollToBottom()
      if (thread && f.message.parentId === thread.parent.id && threadListEl)
        threadListEl.scrollTop = threadListEl.scrollHeight
    } else {
      setConversations(setUnread(conversations, cid, f.unread))
    }
  }

  async function refreshConversations() {
    const fresh = await api<{ conversations: ConversationView[] }>('/api/messages/conversations')
    setConversations(fresh.conversations)
  }

  function connect() {
    stream = new ResumableStream({
      url: (after) => `/api/messages/stream?after=${after}`,
      initialCursor: data.cursor,
      events: ['message', 'conversation', 'read', 'presence', 'presence-error'],
      onStatus: (status) => (live = status),
      onEvent: (type, payload) => {
        if (type === 'message') void onMessageFrame(payload as MessageFrame)
        else if (type === 'conversation') {
          const { conversation } = payload as { conversation: ConversationView }
          setConversations(upsertConversation(conversations, conversation))
        } else if (type === 'read') {
          const { conversationId, unread } = payload as { conversationId: string; unread: number }
          setConversations(setUnread(conversations, conversationId, unread))
        } else if (type === 'presence') {
          const frame = payload as PresenceFrame
          presence = applyPresence(presence, frame)
          presenceError = null
          tellNav(frame.people)
        } else if (type === 'presence-error') {
          presenceError = { error: (payload as { error: string }).error, agent: null }
        }
      },
    })
    stream.connect()
  }

  /** A phone that slept may have dropped the live feed: pick it up after the last event seen. */
  function onOnline() {
    stream?.resume()
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

  async function setDoNotDisturb(on: boolean) {
    dndSaving = true
    try {
      const { presence: mine } = await api<{ presence: PresenceView }>('/api/messages/presence', {
        method: 'PUT',
        body: JSON.stringify({ doNotDisturb: on }),
      })
      presence = applyPresence(presence, { people: [mine], replace: false })
      presenceError = null
      tellNav([mine])
    } catch (err) {
      presenceError = shownFailure(err)
    } finally {
      dndSaving = false
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') stream?.resume()
    void reportViewing()
    if (document.visibilityState === 'visible' && selectedId && selected && selected.unread > 0) {
      void markRead(selectedId)
    }
  }

  /** Esc closes the reaction picker, then the members list, then cancels a pending reply. */
  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    if (pickerFor) pickerFor = null
    else if (membersOpen) membersOpen = false
    else if (threadReplyingTo && document.activeElement === threadComposerEl)
      threadReplyingTo = null
    else if (replyingTo) replyingTo = null
  }

  onMount(() => {
    connect()
    heartbeat = setInterval(() => void reportViewing(), 20_000)
    // "2h ago" / "Today" stay true while the page is open.
    clock = setInterval(() => (now = new Date()), 60_000)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    void syncAppBadge(totalUnread(conversations))
    const initial = page.url.searchParams.get('c')
    const initialThread = page.url.searchParams.get('t')
    if (initial && conversations.some((c) => c.id === initial)) {
      void openConversation(initial, false).then(() => {
        if (initialThread) void openThread(initialThread, false)
      })
    }
  })

  onDestroy(() => {
    stream?.close()
    if (heartbeat) clearInterval(heartbeat)
    if (clock) clearInterval(clock)
    clearTimeout(highlightTimer)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
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
  let channelError = $state<PageError | null>(null)

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
      const { conversation } = await api<{ conversation: ConversationView }>(
        '/api/messages/channels',
        {
          method: 'POST',
          body: JSON.stringify({
            name: channelName,
            topic: channelTopic,
            private: channelPrivate,
            userIds: channelPrivate ? channelPeople : [],
            groupIds: channelPrivate ? channelGroups : [],
          }),
        },
      )
      setConversations(upsertConversation(conversations, conversation))
      channelOpen = false
      void openConversation(conversation.id)
    } catch (err) {
      channelError = failure(err, 'Creating a channel in Messages')
    }
  }

  let dmOpen = $state(false)
  let dmPeople = $state<string[]>([])
  let dmFilter = $state('')
  let dmError = $state<PageError | null>(null)
  const dmCandidates = $derived(
    others.filter((p) =>
      `${p.name} ${p.email}`.toLowerCase().includes(dmFilter.trim().toLowerCase()),
    ),
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
      setConversations(upsertConversation(conversations, conversation))
      dmOpen = false
      void openConversation(conversation.id)
    } catch (err) {
      dmError = failure(err, 'Starting a direct message in Messages')
    }
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
  }

  const personLabel = (p: { name: string; email: string }) => p.name.trim() || p.email
  const placeholder = $derived(
    selected
      ? selected.kind === 'channel'
        ? `Message #${selected.title}`
        : `Message ${selected.title}`
      : '',
  )
</script>

<svelte:head><title>{docTitle('Messages')}</title></svelte:head>
<svelte:window onkeydown={onWindowKey} />

{#snippet conversationRow(c: ConversationView)}
  {@const current = c.id === selectedId}
  {@const dmWith = c.kind === 'dm' ? dmOthers(c) : []}
  <li>
    <button
      type="button"
      class={[
        'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[15px] outline-none focus-visible:ring-2 -ring',
        current
          ? 'bg-primary text-primary-foreground'
          : 'text-foreground/75 hover:bg-foreground/[0.06]',
        c.unread > 0 && !current ? 'font-bold text-foreground' : '',
      ]}
      aria-current={current ? 'true' : undefined}
      data-testid="messages-conversation"
      data-title={c.title}
      data-unread={c.unread}
      onclick={() => openConversation(c.id)}
    >
      {#if c.kind === 'channel'}
        <span class="grid w-5 shrink-0 place-items-center">
          {#if c.private}
            <Lock class="size-3.5 opacity-70" aria-label="Private channel" />
          {:else}
            <Hash class="size-4 opacity-70" aria-hidden="true" />
          {/if}
        </span>
      {:else if dmWith.length === 1}
        <span class="relative shrink-0">
          <UserAvatar
            name={dmWith[0].name}
            image={dmWith[0].image}
            size="xs"
            testid="messages-dm-avatar"
          />
          <PresenceDot
            presence={presenceFor(dmWith[0].id)}
            {now}
            class="absolute -right-1 -bottom-1"
            testid="messages-dm-presence"
          />
        </span>
      {:else}
        <span
          class={[
            'grid size-5 shrink-0 place-items-center rounded-md text-xs font-semibold',
            current ? 'bg-primary-foreground/20' : 'bg-foreground/10',
          ]}
          aria-hidden="true">{dmWith.length || 1}</span
        >
      {/if}
      <span class="min-w-0 flex-1 truncate">{c.title}</span>
      {#if c.unread > 0}
        <span
          class={[
            'min-w-5 shrink-0 rounded-full px-1.5 text-center text-xs leading-5 font-bold tabular-nums',
            current ? 'bg-primary-foreground text-primary' : 'bg-primary text-primary-foreground',
          ]}
          data-testid="messages-unread"
          aria-label="{c.unread} unread">{c.unread > 99 ? '99+' : c.unread}</span
        >
      {/if}
    </button>
  </li>
{/snippet}

{#snippet sectionHeader(
  label: string,
  open: boolean,
  ontoggle: () => void,
  addLabel: string,
  addTestid: string,
  onadd: () => void,
)}
  <div class="group/section flex h-8 items-center gap-1 px-1">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-[13px] font-semibold text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground"
      aria-expanded={open}
      onclick={ontoggle}
    >
      <ChevronDown
        class={['size-3.5 shrink-0 transition-transform', open ? '' : '-rotate-90']}
        aria-hidden="true"
      />
      <span class="truncate">{label}</span>
    </button>
    <button
      type="button"
      class="grid size-6 shrink-0 place-items-center rounded-md text-foreground/60 hover:bg-foreground/[0.08] hover:text-foreground"
      aria-label={addLabel}
      title={addLabel}
      data-testid={addTestid}
      onclick={onadd}><Plus class="size-4" /></button
    >
  </div>
{/snippet}

<div
  class="flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background"
  data-testid="messages-panel"
>
  <!-- ── Sidebar: channels and direct messages (on phones: the whole page until one is open) ── -->
  <nav
    class={[
      'min-h-0 w-full shrink-0 flex-col border-border bg-foreground/[0.025] md:flex md:w-[260px] md:border-r',
      selectedId ? 'hidden' : 'flex',
    ]}
    aria-label="Conversations"
    data-testid="messages-list"
  >
    <div class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
      <h1 class="min-w-0 flex-1 truncate text-lg font-bold tracking-tight">Messages</h1>
      <span
        class="flex items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="messages-live"
        data-state={live}
        title="Live updates"
      >
        <span
          class={[
            'size-1.5 rounded-full',
            live === 'live' ? 'bg-emerald-500' : 'animate-pulse bg-amber-500',
          ]}
          aria-hidden="true"
        ></span>
        {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
      </span>
      <button
        type="button"
        class="grid size-8 place-items-center rounded-md border border-border bg-background text-foreground/70 hover:text-foreground"
        aria-label="New message"
        title="New message"
        data-testid="messages-compose"
        onclick={openNewDm}><SquarePen class="size-4" /></button
      >
    </div>

    <NotificationsBanner />

    <div class="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      {@render sectionHeader(
        'Channels',
        channelsOpen,
        () => (channelsOpen = !channelsOpen),
        'Add channel',
        'messages-new-channel',
        openNewChannel,
      )}
      {#if channelsOpen}
        <ul class="mt-0.5 flex flex-col gap-px" data-testid="messages-channels">
          {#each channels as c (c.id)}{@render conversationRow(c)}{/each}
          <li>
            <button
              type="button"
              class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[15px] text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground"
              data-testid="messages-add-channel-row"
              onclick={openNewChannel}
            >
              <span class="grid size-5 place-items-center rounded-md bg-foreground/[0.08]"
                ><Plus class="size-3.5" aria-hidden="true" /></span
              >
              Add channel
            </button>
          </li>
        </ul>
      {/if}

      <div class="mt-4">
        {@render sectionHeader(
          'Direct messages',
          dmsOpen,
          () => (dmsOpen = !dmsOpen),
          'New message',
          'messages-new-dm',
          openNewDm,
        )}
      </div>
      {#if dmsOpen}
        <ul class="mt-0.5 flex flex-col gap-px" data-testid="messages-dms">
          {#each dms as c (c.id)}{@render conversationRow(c)}{/each}
          {#if dms.length === 0}
            <li class="px-2 py-1 text-xs text-muted-foreground">No direct messages yet.</li>
          {/if}
        </ul>
      {/if}
    </div>

    {#if myself}
      <PresenceSelf
        name={personLabel(myself)}
        image={myself.image ?? null}
        presence={presenceFor(data.me)}
        {now}
        saving={dndSaving}
        error={presenceError}
        ontoggle={(on) => void setDoNotDisturb(on)}
      />
    {/if}
  </nav>

  <!-- ── The conversation (below xl, an open thread takes its place) ── -->
  <section
    class={[
      'min-h-0 min-w-0 flex-1 flex-col',
      thread ? 'hidden xl:flex' : selectedId ? 'flex' : 'hidden md:flex',
    ]}
    aria-label="Conversation"
    data-testid="messages-conversation-view"
  >
    {#if selected}
      {@const dmWith = selected.kind === 'dm' ? dmOthers(selected) : []}
      <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
        <button
          type="button"
          class="-ml-1 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] md:hidden"
          aria-label="Back to conversations"
          data-testid="messages-back"
          onclick={closeConversation}><ArrowLeft class="size-4" /></button
        >
        {#if selected.kind === 'dm' && dmWith.length === 1}
          <span class="relative shrink-0">
            <UserAvatar name={dmWith[0].name} image={dmWith[0].image} size="sm" />
            <PresenceDot
              presence={presenceFor(dmWith[0].id)}
              {now}
              class="absolute -right-1 -bottom-1"
              testid="messages-header-presence"
            />
          </span>
        {/if}
        <div class="min-w-0 flex-1">
          <h2
            class="flex min-w-0 items-center gap-1 text-base font-bold"
            data-testid="messages-title"
          >
            {#if selected.kind === 'channel'}
              {#if selected.private}<Lock
                  class="size-4 shrink-0"
                  aria-label="Private"
                />{:else}<Hash class="size-4 shrink-0" aria-hidden="true" />{/if}
            {/if}
            <span class="truncate">{selected.title}</span>
          </h2>
          {#if selected.topic}
            <p class="truncate text-xs text-muted-foreground" data-testid="messages-topic">
              {selected.topic}
            </p>
          {/if}
          {#if selected.kind === 'dm' && dmWith.length === 1}
            <p class="truncate text-xs text-muted-foreground" data-testid="messages-presence-label">
              {presenceLabel(presenceFor(dmWith[0].id), now)}
            </p>
          {/if}
        </div>

        <CallButton
          kind={selected.kind}
          contextId={selected.id}
          live={liveCalls.liveFor(selected.kind, selected.id)}
          client={calls}
        />

        <div class="relative shrink-0">
          {#if members}
            <button
              type="button"
              class="flex h-8 items-center gap-1.5 rounded-md border border-border px-1.5 pr-2 text-xs font-semibold hover:bg-foreground/[0.04]"
              aria-label="{members.length} {members.length === 1 ? 'member' : 'members'}"
              aria-expanded={membersOpen}
              data-testid="messages-members"
              data-count={members.length}
              onclick={() => (membersOpen = !membersOpen)}
            >
              <span class="flex -space-x-1" aria-hidden="true">
                {#each members.slice(0, 3) as p (p.id)}
                  <UserAvatar
                    name={p.name}
                    image={p.image ?? null}
                    size="xs"
                    class="ring-2 ring-background"
                    testid="messages-member-avatar"
                  />
                {/each}
              </span>
              <span class="tabular-nums">{members.length}</span>
            </button>
            {#if membersOpen}
              <div
                class="absolute top-full right-0 z-30 mt-1 w-64 rounded-lg border border-border bg-popover p-1 shadow-lg"
                data-testid="messages-members-list"
              >
                <p class="px-2 pt-1.5 pb-1 text-xs font-semibold text-muted-foreground">
                  {members.length}
                  {members.length === 1 ? 'member' : 'members'}
                </p>
                <ul class="max-h-72 overflow-y-auto">
                  {#each members as p (p.id)}
                    {@const status = presenceFor(p.id)}
                    <li
                      class="flex items-center gap-2 rounded-md px-2 py-1.5"
                      data-testid="messages-member"
                      data-status={status.status}
                    >
                      <span class="relative shrink-0">
                        <UserAvatar name={p.name} image={p.image ?? null} size="sm" />
                        <PresenceDot
                          presence={status}
                          {now}
                          class="absolute -right-1 -bottom-1"
                          testid="messages-member-presence"
                        />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm">{personLabel(p)}</span>
                        <span class="block truncate text-xs text-muted-foreground"
                          >{presenceLabel(status, now)}</span
                        >
                      </span>
                      {#if p.id === data.me}<span class="text-xs text-muted-foreground">you</span
                        >{/if}
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          {:else if membersError}
            <span class="flex items-start gap-1 text-xs" title={membersError.error}>
              <Users class="mt-0.5 size-3.5 shrink-0 text-red-600" aria-hidden="true" />
              <ErrorNotice
                class="text-xs"
                testid="messages-members-error"
                error="Members unavailable"
                agent={membersError.agent}
                attempted={membersError.attempted}
              />
            </span>
          {/if}
        </div>
      </header>

      <div
        class="min-h-0 flex-1 overflow-y-auto pb-3"
        bind:this={listEl}
        data-testid="messages-log"
        role="log"
        aria-label="Messages in {selected.kind === 'channel'
          ? `#${selected.title}`
          : selected.title}"
      >
        {#if hasMore}
          <div class="flex justify-center pt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={loadingEarlier}
              onclick={loadEarlier}
              data-testid="messages-load-earlier"
              >{loadingEarlier ? 'Loading…' : 'Load earlier'}</Button
            >
          </div>
        {:else if messages.length > 0}
          <div class="px-5 pt-8 pb-2">
            <p class="text-lg font-bold">
              {selected.kind === 'channel' ? `#${selected.title}` : selected.title}
            </p>
            <p class="text-sm text-muted-foreground">
              {selected.kind === 'channel'
                ? `This is the very beginning of #${selected.title}.${selected.topic ? ` ${selected.topic}` : ''}`
                : 'This is the very beginning of your direct message history.'}
            </p>
          </div>
        {/if}
        {#if messages.length === 0}
          <div class="grid h-full place-items-center p-8 text-center" data-testid="messages-empty">
            <div>
              <p class="text-base font-semibold">No messages yet</p>
              <p class="mt-1 text-sm text-muted-foreground">
                Say hello — everything you write here stays in this conversation.
              </p>
            </div>
          </div>
        {/if}
        {#each days as day (day.key)}
          <div class="relative" data-testid="messages-day-group">
            <div
              class="sticky top-0 z-20 flex items-center justify-center py-1.5"
              data-testid="messages-day"
            >
              <span class="absolute inset-x-0 top-1/2 h-px bg-border" aria-hidden="true"></span>
              <span
                class="relative rounded-full border border-border bg-background px-3 py-0.5 text-xs font-semibold shadow-xs"
                >{day.label}</span
              >
            </div>
            {#each messageRows(day.messages) as row (row.message.id)}
              {@const m = row.message}
              <MessageRow
                message={m}
                grouped={row.grouped}
                me={data.me}
                canEdit={canEdit(m)}
                canDelete={canDelete(m)}
                editing={editingId === m.id}
                pickerOpen={pickerFor === m.id}
                reactionEmoji={data.reactionEmoji}
                repliers={m.replierIds.map(rowPerson)}
                {mentions}
                {now}
                highlighted={highlightId === m.id}
                onquote={() => startQuote(m, 'log')}
                onopenquote={() => m.replyTo && jumpToQuote(m.replyTo)}
                onreact={(emoji) => react(m, emoji)}
                ontogglepicker={() => (pickerFor = pickerFor === m.id ? null : m.id)}
                onreply={() => openThread(m.id)}
                onstartedit={() => startEdit(m)}
                onsaveedit={(body) => saveEdit(m, body)}
                oncanceledit={() => (editingId = null)}
                ondelete={() => {
                  deleteError = null
                  deleteTarget = m
                }}
              />
            {/each}
          </div>
        {/each}
      </div>

      <input
        bind:this={fileInput}
        type="file"
        multiple
        class="hidden"
        data-testid="messages-file-input"
        onchange={onPickFiles}
      />
      <MessageComposer
        bind:value={draft}
        bind:textarea={composerEl}
        {placeholder}
        label="Message"
        {canSend}
        emoji={data.reactionEmoji}
        inputTestid="messages-composer"
        sendTestid="messages-send"
        formTestid="messages-composer-form"
        {dragging}
        onsend={send}
        ondraft={(text) => {
          if (selectedId) drafts.write(selectedId, text)
        }}
        onattach={() => fileInput?.click()}
        onpaste={onPaste}
        ondragover={onDragOver}
        ondragleave={() => (dragging = false)}
        ondrop={onDrop}
        onrecording={(recording) => void attachVoice(recording)}
      >
        {#snippet above()}
          {#if replyingTo}
            <ReplyQuote
              quote={quoteOf(replyingTo)}
              composer
              ondismiss={() => (replyingTo = null)}
            />
          {/if}
          {#if notice}
            <p
              class="px-3 pt-2 text-xs text-muted-foreground"
              role="status"
              data-testid="messages-notice"
            >
              {notice}
            </p>
          {/if}
          {#if errorText}
            <ErrorNotice
              class="px-3 pt-2 text-xs"
              testid="messages-error"
              error={errorText.error}
              agent={errorText.agent}
              attempted={errorText.attempted}
            />
          {/if}
          {#if pendingFiles.length > 0}
            <ul class="flex flex-wrap gap-2 px-3 pt-2.5" data-testid="messages-pending">
              {#each pendingFiles as p (p.key)}
                <li
                  class="flex max-w-60 items-center gap-2 rounded-lg border border-border bg-foreground/[0.03] py-1.5 pr-1 pl-2 text-xs"
                  data-testid="messages-pending-file"
                  data-status={p.status}
                  data-name={p.name}
                  data-voice={p.voiceMs !== undefined}
                >
                  {#if p.status === 'uploading'}<LoaderCircle
                      class="size-4 shrink-0 animate-spin text-muted-foreground"
                      aria-label="Uploading"
                    />{:else if p.voiceMs !== undefined}<Mic
                      class="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />{:else}<Paperclip
                      class="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />{/if}
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{p.name}</span>
                    {#if p.voiceMs !== undefined}<span class="block text-xs text-muted-foreground"
                        >{formatVoiceTimer(p.voiceMs)} · plays with the text</span
                      >{:else if p.file}<span class="block text-xs text-muted-foreground"
                        >{formatSize(p.file.size)}</span
                      >{/if}
                  </span>
                  <button
                    type="button"
                    class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                    aria-label="Remove {p.name}"
                    onclick={() => (pendingFiles = pendingFiles.filter((x) => x.key !== p.key))}
                    ><X class="size-3.5" /></button
                  >
                </li>
              {/each}
            </ul>
          {/if}
        {/snippet}
      </MessageComposer>
    {:else}
      <div class="grid flex-1 place-items-center p-8 text-center">
        <div>
          <p class="text-base font-semibold">Pick a conversation</p>
          <p class="mt-1 text-sm text-muted-foreground">
            Or start one with “Add channel” or “New message”.
          </p>
        </div>
      </div>
    {/if}
  </section>

  <!-- ── Thread pane ── -->
  {#if thread && selected}
    <aside
      class="flex min-h-0 w-full min-w-0 flex-col border-border bg-background md:border-l xl:w-[400px] xl:shrink-0"
      aria-label="Thread"
      data-testid="messages-thread"
    >
      <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-bold">Thread</h2>
          <p class="truncate text-xs text-muted-foreground">
            {selected.kind === 'channel' ? `#${selected.title}` : selected.title}
          </p>
        </div>
        <button
          type="button"
          class="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Close thread"
          data-testid="messages-thread-close"
          onclick={closeThread}><X class="size-4" /></button
        >
      </header>
      <div
        class="min-h-0 flex-1 overflow-y-auto pb-3"
        bind:this={threadListEl}
        data-testid="thread-log"
      >
        {@render threadRow(thread.parent, false)}
        <div class="my-2 flex items-center gap-3 px-5">
          <span class="text-xs font-medium text-muted-foreground" data-testid="thread-count"
            >{thread.replies.length === 0
              ? 'No replies yet'
              : `${thread.replies.length} ${thread.replies.length === 1 ? 'reply' : 'replies'}`}</span
          >
          <span class="h-px flex-1 bg-border"></span>
        </div>
        {#each messageRows(thread.replies) as row (row.message.id)}
          {@render threadRow(row.message, row.grouped)}
        {/each}
      </div>
      {#if threadError}
        <ErrorNotice
          class="px-5 pb-1 text-xs"
          error={threadError.error}
          agent={threadError.agent}
          attempted={threadError.attempted}
        />
      {/if}
      <MessageComposer
        bind:value={threadDraft}
        bind:textarea={threadComposerEl}
        placeholder="Reply…"
        label="Reply"
        canSend={!threadSending && threadDraft.trim().length > 0}
        emoji={data.reactionEmoji}
        inputTestid="thread-composer"
        sendTestid="thread-send"
        hint={false}
        onsend={sendReply}
      >
        {#snippet above()}
          {#if threadReplyingTo}
            <ReplyQuote
              quote={quoteOf(threadReplyingTo)}
              composer
              ondismiss={() => (threadReplyingTo = null)}
            />
          {/if}
        {/snippet}
      </MessageComposer>
    </aside>
  {/if}
</div>

{#snippet threadRow(m: MessageView, grouped: boolean)}
  <MessageRow
    message={m}
    {grouped}
    inThread
    me={data.me}
    canEdit={canEdit(m)}
    canDelete={canDelete(m)}
    editing={editingId === m.id}
    pickerOpen={pickerFor === m.id}
    reactionEmoji={data.reactionEmoji}
    {mentions}
    {now}
    highlighted={highlightId === m.id}
    onquote={() => startQuote(m, 'thread')}
    onopenquote={() => m.replyTo && jumpToQuote(m.replyTo)}
    onreact={(emoji) => react(m, emoji)}
    ontogglepicker={() => (pickerFor = pickerFor === m.id ? null : m.id)}
    onstartedit={() => startEdit(m)}
    onsaveedit={(body) => saveEdit(m, body)}
    oncanceledit={() => (editingId = null)}
    ondelete={() => {
      deleteError = null
      deleteTarget = m
    }}
  />
{/snippet}

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
          You’re deleting {deleteTarget.authorName}’s message as a moderator. Everyone will see
          “Message deleted”, and the deletion is recorded in the audit log.
        {:else}
          Everyone will see “Message deleted” in its place. This can’t be undone.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    {#if deleteError}
      <ErrorNotice
        error={deleteError.error}
        agent={deleteError.agent}
        attempted={deleteError.attempted}
      />
    {/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
      <Button variant="destructive" onclick={confirmDelete} data-testid="messages-delete-confirm"
        >Delete</Button
      >
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
        <Input
          id="channel-name"
          bind:value={channelName}
          placeholder="general"
          required
          maxlength={80}
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="channel-topic">Topic (optional)</Label>
        <Input id="channel-topic" bind:value={channelTopic} placeholder="What it's about" />
      </div>
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1 text-sm font-medium">Who can see it</legend>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="visibility"
            checked={!channelPrivate}
            onchange={() => (channelPrivate = false)}
            data-testid="channel-public"
          />
          <span
            ><span class="font-medium">Everyone</span> — anyone in the company can read and post.</span
          >
        </label>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="visibility"
            checked={channelPrivate}
            onchange={() => (channelPrivate = true)}
            data-testid="channel-private"
          />
          <span
            ><span class="font-medium">Private</span> — only the people and groups you invite.</span
          >
        </label>
      </fieldset>
      {#if channelPrivate}
        <div
          class="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2"
          data-testid="channel-invite"
        >
          {#if data.groups.length > 0}
            <p class="text-xs font-medium text-muted-foreground">Groups</p>
            {#each data.groups as g (g.id)}
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={channelGroups.includes(g.id)}
                  onchange={() => (channelGroups = toggle(channelGroups, g.id))}
                />
                {g.name}
              </label>
            {/each}
          {/if}
          <p class="text-xs font-medium text-muted-foreground">People</p>
          {#if others.length === 0}<p class="text-xs text-muted-foreground">
              No one else in the company yet.
            </p>{/if}
          {#each others as p (p.id)}
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={channelPeople.includes(p.id)}
                onchange={() => (channelPeople = toggle(channelPeople, p.id))}
              />
              <span class="relative shrink-0">
                <UserAvatar name={personLabel(p)} image={p.image ?? null} size="xs" />
                <PresenceDot
                  presence={presenceFor(p.id)}
                  {now}
                  class="absolute -right-1 -bottom-1"
                />
              </span>
              <span class="truncate">{personLabel(p)}</span>
              <span class="truncate text-xs text-muted-foreground">{p.email}</span>
            </label>
          {/each}
        </div>
      {/if}
      {#if channelError}
        <ErrorNotice
          error={channelError.error}
          agent={channelError.agent}
          attempted={channelError.attempted}
        />
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (channelOpen = false)}>Cancel</Button
        >
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
      <Input
        dictation={false}
        bind:value={dmFilter}
        placeholder="Search people"
        aria-label="Search people"
      />
      <div
        class="flex max-h-60 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1.5"
        data-testid="dm-people"
      >
        {#if dmCandidates.length === 0}<p class="p-1 text-xs text-muted-foreground">
            No one found.
          </p>{/if}
        {#each dmCandidates as p (p.id)}
          <label
            class="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-sm hover:bg-foreground/[0.04]"
          >
            <input
              type="checkbox"
              checked={dmPeople.includes(p.id)}
              onchange={() => (dmPeople = toggle(dmPeople, p.id))}
              data-testid="dm-person"
              data-email={p.email}
            />
            <span class="relative shrink-0">
              <UserAvatar name={personLabel(p)} image={p.image ?? null} size="sm" />
              <PresenceDot
                presence={presenceFor(p.id)}
                {now}
                class="absolute -right-1 -bottom-1"
                testid="dm-person-presence"
              />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{personLabel(p)}</span>
              <span class="block truncate text-xs text-muted-foreground"
                >{p.email} · {presenceLabel(presenceFor(p.id), now)}</span
              >
            </span>
          </label>
        {/each}
      </div>
      {#if dmError}
        <ErrorNotice error={dmError.error} agent={dmError.agent} attempted={dmError.attempted} />
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (dmOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={dmPeople.length === 0} data-testid="dm-start">Start</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
