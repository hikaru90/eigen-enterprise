<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert'
  import LoaderIcon from '@lucide/svelte/icons/loader-circle'
  import LockIcon from '@lucide/svelte/icons/lock'
  import { onMount, untrack, type Snippet } from 'svelte'
  import { beforeNavigate, goto } from '$app/navigation'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import {
    DriveApiError,
    driveApi,
    type DriveItem,
    type LockHolder,
    type Revision,
  } from '$lib/drive/api'
  import { createAutosave, LockLostError, type AutosaveState } from '$lib/drive/autosave'
  import CsvEditor from './csv-editor.svelte'
  import MarkdownEditor from './markdown-editor.svelte'
  import RevisionsPanel from './revisions-panel.svelte'

  /**
   * In-place editing of a Markdown/CSV file (D2, W-6). Opening a file is
   * reading it: the edit lock is taken only when the person starts editing
   * (first keystroke, or "Edit"), kept alive by a heartbeat every
   * `heartbeatMs`, and let go after `idleMs` without a change (everything
   * saved first). While someone else holds it the document is read-only with
   * "<name> is editing" and Take over. Edits autosave (debounced) through the
   * text API — one revision per editing session. A taken-over editor stops
   * saving and keeps its unsaved draft on screen (and in this browser's
   * storage) to copy. Leaving waits for the last save (in-app navigation) or
   * sends it with keepalive (closing/hiding the page).
   */
  let {
    fileId,
    kind,
    content,
    revisions,
    authors,
    heartbeatMs,
    saveDelayMs = 1200,
    idleMs = 60_000,
    onsaved,
    side,
  }: {
    fileId: string
    kind: 'markdown' | 'csv'
    content: string
    revisions: Revision[]
    authors: Record<string, string>
    heartbeatMs: number
    saveDelayMs?: number
    idleMs?: number
    /** The file as the server has it after a save or restore (size, changed time). */
    onsaved?: (file: DriveItem) => void
    /** The file's details and sharing, shown above the revisions in the side panel. */
    side?: Snippet
  } = $props()

  type Mode =
    | { kind: 'opening' }
    | { kind: 'reading' }
    | { kind: 'starting' }
    | { kind: 'editing' }
    | { kind: 'watching'; holder: LockHolder }
    | { kind: 'lost'; holder: LockHolder | null; draft: string }

  const session = crypto.randomUUID()
  const draftKey = () => `drive-draft:${fileId}`
  let mode = $state<Mode>({ kind: 'opening' })
  let save = $state<AutosaveState>({ status: 'saved', error: null, savedAt: null })
  let revs = $state<Revision[]>([])
  let lockError = $state<string | null>(null)
  let editor = $state<{
    load(text: string): void
    setEditable(next: boolean): void
    markdown?: () => string | null
    baseline?: () => string | null
  } | null>(null)
  /** The last text the editor reported (or was loaded with). */
  let lastSeen = untrack(() => content)
  /** The text as last loaded from / saved to the server (what a read view shows). */
  let base = untrack(() => content)
  /** Keystrokes made while the lock is being taken. */
  let early: string | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const autosave = createAutosave({
    delayMs: untrack(() => saveDelayMs),
    onState: (s) => (save = s),
    onLost: () => loseLock(lostHolder),
    async save(text) {
      try {
        const out = await driveApi.writeText(fileId, text, session)
        base = text
        onsaved?.(out.file)
      } catch (err) {
        if (err instanceof DriveApiError && err.code === 'locked') {
          lostHolder = err.holder
          throw new LockLostError(err.message, err.holder?.userId ?? null)
        }
        throw err
      }
      void refreshRevisions()
    },
  })
  let lostHolder: LockHolder | null = null

  onMount(() => {
    revs = revisions
    void openForReading()
    const beat = setInterval(() => void heartbeat(), heartbeatMs)
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (autosave.unsaved() === null || mode.kind !== 'editing') return
      void autosave.flush()
      event.preventDefault()
    }
    // The page is going away (closed, reloaded, backgrounded on a phone): send
    // the last edits with keepalive, which outlives the unload.
    const sendOnExit = () => {
      catchUp()
      const text = autosave.unsaved()
      if (text !== null && mode.kind === 'editing')
        void driveApi.writeTextOnExit(fileId, text, session)
    }
    const onPageHide = () => {
      sendOnExit()
      if (mode.kind === 'editing') void driveApi.releaseLock(fileId, session)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') sendOnExit()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(beat)
      clearIdle()
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibility)
      if (mode.kind === 'editing')
        void autosave.flush().then(() => driveApi.releaseLock(fileId, session))
    }
  })

  // In-app navigation waits for the last save, then continues: typing and
  // leaving right away never loses the text (and the next page shows it saved).
  let leaving = false
  beforeNavigate((nav) => {
    if (leaving) return
    catchUp()
    const startingUp = mode.kind === 'starting'
    if (!startingUp && mode.kind !== 'editing') return
    if (!startingUp && autosave.unsaved() === null && save.status !== 'saving') return
    if (save.status === 'error') {
      if (!confirm('Your latest changes could not be saved. Leave anyway and lose them?'))
        nav.cancel()
      return
    }
    if (nav.type === 'leave') {
      // Closing the tab: the keepalive save in pagehide covers it.
      return
    }
    const to = nav.to?.url
    if (!to || nav.type === 'popstate') {
      void autosave.flush()
      return
    }
    nav.cancel()
    leaving = true
    void (starting ?? Promise.resolve())
      .then(() => autosave.flush())
      .then(async () => {
        try {
          if (
            save.status === 'error' &&
            !confirm('Your latest changes could not be saved. Leave anyway and lose them?')
          )
            return
          // The navigation the person already started (an app URL SvelteKit resolved);
          // invalidateAll: data preloaded on hover predates the save (sizes would read stale).
          // eslint-disable-next-line svelte/no-navigation-without-resolve
          await goto(to.href, { invalidateAll: true })
        } finally {
          leaving = false
        }
      })
  })

  /** On open: read-only while someone else edits, else the read view (editing starts on the first change). */
  async function openForReading() {
    lockError = null
    try {
      const lock = await driveApi.lockStatus(fileId)
      if (lock.state === 'locked' && lock.holder.sessionId !== session) {
        mode = { kind: 'watching', holder: lock.holder }
        editor?.setEditable(false)
      } else {
        mode = { kind: 'reading' }
        editor?.setEditable(true)
      }
    } catch (err) {
      lockError = err instanceof Error ? err.message : String(err)
    }
  }

  /** The lock being taken right now (navigation waits for it, then for the save). */
  let starting: Promise<void> | null = null
  /** Takes the edit lock (`takeover`: even from someone else). */
  function startEditing(takeover: boolean): Promise<void> {
    starting = takeLock(takeover).finally(() => (starting = null))
    return starting
  }
  async function takeLock(takeover: boolean) {
    lockError = null
    const was = mode
    mode = { kind: 'starting' }
    try {
      const lock = await driveApi.acquireLock(fileId, session, takeover)
      if (lock.state === 'held') {
        if (takeover || was.kind === 'watching' || was.kind === 'lost') await reloadText()
        mode = { kind: 'editing' }
        editor?.setEditable(true)
        if (early !== null) autosave.change(early)
        early = null
        touchIdle()
      } else if (lock.state === 'locked') {
        // Someone started editing first: what was typed here is kept to copy.
        const draft = early
        early = null
        if (draft !== null && draft !== base) {
          lostHolder = lock.holder
          mode = { kind: 'lost', holder: lock.holder, draft }
          try {
            localStorage.setItem(draftKey(), draft)
          } catch {
            // Storage blocked: the draft stays on screen.
          }
        } else mode = { kind: 'watching', holder: lock.holder }
        editor?.setEditable(false)
        await reloadText()
      } else mode = was
    } catch (err) {
      mode = was
      lockError = err instanceof Error ? err.message : String(err)
    }
  }

  function clearIdle() {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
  }
  /** Editing ends after a quiet spell: save what is left, let go of the lock, back to reading. */
  function touchIdle() {
    clearIdle()
    idleTimer = setTimeout(() => void stopEditing(), idleMs)
  }
  async function stopEditing() {
    clearIdle()
    if (mode.kind !== 'editing') return
    await autosave.flush()
    if (mode.kind !== 'editing' || autosave.unsaved() !== null || save.status !== 'saved') {
      if (mode.kind === 'editing') touchIdle()
      return
    }
    mode = { kind: 'reading' }
    await driveApi.releaseLock(fileId, session)
  }

  async function heartbeat() {
    try {
      if (mode.kind === 'editing') {
        const lock = await driveApi.heartbeatLock(fileId, session)
        if (lock.state === 'locked') {
          lostHolder = lock.holder
          autosave.stop()
          loseLock(lock.holder)
        }
      } else if (mode.kind === 'watching' || mode.kind === 'reading') {
        // Keep the read copy current; show who starts editing; free again → readable.
        const lock = await driveApi.lockStatus(fileId)
        if (mode.kind !== 'watching' && mode.kind !== 'reading') return
        if (lock.state === 'locked' && lock.holder.sessionId !== session) {
          if (mode.kind === 'reading') editor?.setEditable(false)
          mode = { kind: 'watching', holder: lock.holder }
          await reloadText()
        } else if (mode.kind === 'watching') {
          await reloadText()
          mode = { kind: 'reading' }
          editor?.setEditable(true)
        } else if (early === null) {
          const { content: text } = await driveApi.readText(fileId)
          if (mode.kind === 'reading' && early === null && text !== base) {
            editor?.load(text)
            autosave.reset(text)
            base = text
            lastSeen = text
          }
        }
      }
    } catch (err) {
      lockError = err instanceof Error ? err.message : String(err)
    }
  }

  function loseLock(holder: LockHolder | null) {
    if (mode.kind === 'lost') return
    clearIdle()
    const draft = autosave.unsaved()
    if (draft !== null) {
      try {
        localStorage.setItem(draftKey(), draft)
      } catch {
        // Storage full or blocked: the draft stays on screen below.
      }
    }
    mode = { kind: 'lost', holder: holder ?? lostHolder, draft: draft ?? '' }
    editor?.setEditable(false)
  }

  async function reloadText() {
    const { content: text } = await driveApi.readText(fileId)
    editor?.load(text)
    autosave.reset(text)
    base = text
    lastSeen = text
  }

  async function refreshRevisions() {
    try {
      revs = (await driveApi.revisions(fileId)).revisions
    } catch (err) {
      lockError = err instanceof Error ? err.message : String(err)
    }
  }

  async function restore(revisionId: string) {
    await autosave.flush()
    const reading = mode.kind === 'reading'
    const out = await driveApi.restoreRevision(fileId, revisionId, session)
    // Restoring from the read view takes the lock only for that one write.
    if (reading) await driveApi.releaseLock(fileId, session)
    onsaved?.(out.file)
    await reloadText()
    await refreshRevisions()
  }

  async function copyDraft(text: string) {
    await navigator.clipboard.writeText(text)
  }

  /**
   * The Markdown editor reports changes debounced (~200 ms): before leaving,
   * pick up what was typed since, so the last keystrokes are saved too.
   */
  function catchUp() {
    const md = editor?.markdown?.()
    if (md == null || md === lastSeen || md === editor?.baseline?.()) return
    onchange(md)
  }

  const onchange = (text: string) => {
    lastSeen = text
    if (mode.kind === 'editing') {
      autosave.change(text)
      touchIdle()
    } else if (mode.kind === 'reading' || mode.kind === 'starting') {
      early = text
      if (mode.kind === 'reading') void startEditing(false)
    }
  }
  const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { timeStyle: 'short' })
</script>

<div class="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
<div class="flex min-w-0 flex-col gap-4">
  {#if mode.kind === 'watching'}
    <div
      class="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm"
      role="status"
      data-testid="drive-lock-banner"
    >
      <LockIcon class="size-4 text-muted-foreground" />
      <span class="flex-1"
        ><strong data-testid="drive-lock-holder">{mode.holder.name}</strong> is editing. You see their
        last saved version, read-only.</span
      >
      <Button
        size="sm"
        variant="outline"
        onclick={() => startEditing(true)}
        data-testid="drive-takeover">Take over</Button
      >
    </div>
  {:else if mode.kind === 'lost'}
    <div
      class="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
      role="alert"
      data-testid="drive-lost-banner"
    >
      <div class="flex flex-wrap items-center gap-3">
        <CircleAlertIcon class="size-4 text-destructive" />
        <span class="flex-1"
          ><strong>{mode.holder?.name ?? 'Someone'}</strong> took over editing. This copy is read-only
          now.</span
        >
        <Button
          size="sm"
          variant="outline"
          onclick={() => startEditing(true)}
          data-testid="drive-takeover">Take it back</Button
        >
      </div>
      {#if mode.draft}
        <p>
          Your last changes were not saved. They are kept here (and in this browser) so you can copy
          them:
        </p>
        <Textarea
          class="h-32 font-mono text-xs"
          readonly
          value={mode.draft}
          data-testid="drive-lost-draft"
        />
        <div>
          <Button
            size="sm"
            variant="outline"
            onclick={() => copyDraft(mode.kind === 'lost' ? mode.draft : '')}
            >Copy my changes</Button
          >
        </div>
      {/if}
    </div>
  {/if}
  {#if lockError}<p class="text-sm text-destructive" role="alert" data-testid="drive-lock-error">
      {lockError}
    </p>{/if}

  <div
    class="flex min-h-[60vh] flex-1 flex-col overflow-hidden rounded-lg border bg-card"
    data-testid="drive-preview"
    data-kind={kind}
  >
    <div
      class="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="drive-editor-status-bar"
    >
      <span class="flex-1" data-testid="drive-editor-mode" data-mode={mode.kind}
        >{mode.kind === 'editing'
          ? 'Editing'
          : mode.kind === 'opening'
            ? 'Opening…'
            : mode.kind === 'starting'
              ? 'Starting to edit…'
              : mode.kind === 'reading'
                ? 'Viewing — start typing to edit'
                : 'Read-only'}</span
      >
      {#if mode.kind === 'reading'}
        <Button
          size="sm"
          variant="outline"
          class="h-6 px-2 text-xs"
          onclick={() => startEditing(false)}
          data-testid="drive-start-editing">Edit</Button
        >
      {:else if mode.kind === 'editing'}
        <Button
          size="sm"
          variant="ghost"
          class="h-6 px-2 text-xs"
          onclick={() => stopEditing()}
          data-testid="drive-stop-editing">Done</Button
        >
      {/if}
      {#if mode.kind === 'editing' || mode.kind === 'lost'}
        <span
          class="flex items-center gap-1.5"
          data-testid="drive-save-state"
          data-status={save.status}
          aria-live="polite"
        >
          {#if save.status === 'saving'}
            <LoaderIcon class="size-3.5 animate-spin" /> Saving…
          {:else if save.status === 'dirty'}
            Unsaved changes
          {:else if save.status === 'error'}
            <CircleAlertIcon class="size-3.5 text-destructive" /><span
              class="text-destructive"
              title={save.error ?? ''}>Couldn’t save</span
            >
            <Button
              size="sm"
              variant="outline"
              class="h-6 px-2 text-xs"
              onclick={() => autosave.retry()}
              data-testid="drive-save-retry">Retry</Button
            >
          {:else if save.status === 'lost'}
            Not saved — taken over
          {:else}
            <CheckIcon class="size-3.5" /> Saved{save.savedAt ? ` ${fmtTime(save.savedAt)}` : ''}
          {/if}
        </span>
      {/if}
    </div>
    {#if kind === 'markdown'}
      <MarkdownEditor bind:this={editor} {content} editable={false} {onchange} />
    {:else}
      <CsvEditor bind:this={editor} {content} editable={false} {onchange} />
    {/if}
  </div>

</div>
<aside class="flex min-w-0 flex-col gap-6" data-testid="drive-file-side">
  {@render side?.()}
  <RevisionsPanel
    {fileId}
    {kind}
    revisions={revs}
    {authors}
    canRestore={mode.kind === 'editing' || mode.kind === 'reading'}
    onrestore={restore}
  />
</aside>
</div>
