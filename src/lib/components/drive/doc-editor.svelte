<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert'
  import LoaderIcon from '@lucide/svelte/icons/loader-circle'
  import LockIcon from '@lucide/svelte/icons/lock'
  import { onMount, untrack } from 'svelte'
  import { beforeNavigate } from '$app/navigation'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import { DriveApiError, driveApi, type LockHolder, type Revision } from '$lib/drive/api'
  import { createAutosave, LockLostError, type AutosaveState } from '$lib/drive/autosave'
  import CsvEditor from './csv-editor.svelte'
  import MarkdownEditor from './markdown-editor.svelte'
  import RevisionsPanel from './revisions-panel.svelte'

  /**
   * In-place editing of a Markdown/CSV file (D2, W-6): opening it takes the
   * edit lock (heartbeat every `heartbeatMs`); while someone else holds it
   * the document is read-only with "<name> is editing" and Take over. Edits
   * autosave (debounced) through the text API — every save is a revision.
   * A taken-over editor stops saving and keeps its unsaved draft on screen
   * (and in this browser's storage) to copy. Leaving with unsaved edits warns.
   */
  let {
    fileId,
    kind,
    content,
    revisions,
    authors,
    heartbeatMs,
    saveDelayMs = 1200,
  }: {
    fileId: string
    kind: 'markdown' | 'csv'
    content: string
    revisions: Revision[]
    authors: Record<string, string>
    heartbeatMs: number
    saveDelayMs?: number
  } = $props()

  type Mode =
    | { kind: 'opening' }
    | { kind: 'editing' }
    | { kind: 'watching'; holder: LockHolder }
    | { kind: 'lost'; holder: LockHolder | null; draft: string }

  const session = crypto.randomUUID()
  const draftKey = () => `drive-draft:${fileId}`
  let mode = $state<Mode>({ kind: 'opening' })
  let save = $state<AutosaveState>({ status: 'saved', error: null, savedAt: null })
  let revs = $state<Revision[]>([])
  let lockError = $state<string | null>(null)
  let editor = $state<{ load(text: string): void; setEditable(next: boolean): void } | null>(null)

  const autosave = createAutosave({
    delayMs: untrack(() => saveDelayMs),
    onState: (s) => (save = s),
    onLost: () => loseLock(lostHolder),
    async save(text) {
      try {
        await driveApi.writeText(fileId, text, session)
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
    void open(false)
    const beat = setInterval(() => void heartbeat(), heartbeatMs)
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (autosave.unsaved() === null) return
      void autosave.flush()
      event.preventDefault()
    }
    const onPageHide = () => {
      if (mode.kind === 'editing') void driveApi.releaseLock(fileId, session)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      clearInterval(beat)
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
      if (mode.kind === 'editing')
        void autosave.flush().then(() => driveApi.releaseLock(fileId, session))
    }
  })

  beforeNavigate((nav) => {
    if (autosave.unsaved() === null || mode.kind !== 'editing') return
    if (save.status === 'error') {
      if (!confirm('Your latest changes could not be saved. Leave anyway and lose them?'))
        nav.cancel()
      return
    }
    void autosave.flush()
  })

  async function open(takeover: boolean) {
    lockError = null
    try {
      const lock = await driveApi.acquireLock(fileId, session, takeover)
      if (lock.state === 'held') {
        if (takeover || mode.kind !== 'opening') await reloadText()
        mode = { kind: 'editing' }
        editor?.setEditable(true)
      } else if (lock.state === 'locked') {
        mode = { kind: 'watching', holder: lock.holder }
        editor?.setEditable(false)
      }
    } catch (err) {
      lockError = err instanceof Error ? err.message : String(err)
    }
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
      } else if (mode.kind === 'watching') {
        // Keep the read-only copy current; take the lock as soon as it is free.
        await reloadText()
        await open(false)
      }
    } catch (err) {
      lockError = err instanceof Error ? err.message : String(err)
    }
  }

  function loseLock(holder: LockHolder | null) {
    if (mode.kind === 'lost') return
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
    await driveApi.restoreRevision(
      fileId,
      revisionId,
      mode.kind === 'editing' ? session : undefined,
    )
    await reloadText()
    await refreshRevisions()
  }

  async function copyDraft(text: string) {
    await navigator.clipboard.writeText(text)
  }

  const onchange = (text: string) => {
    if (mode.kind === 'editing') autosave.change(text)
  }
  const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { timeStyle: 'short' })
</script>

<div class="flex flex-col gap-4">
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
      <Button size="sm" variant="outline" onclick={() => open(true)} data-testid="drive-takeover"
        >Take over</Button
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
        <Button size="sm" variant="outline" onclick={() => open(true)} data-testid="drive-takeover"
          >Take it back</Button
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

  <div class="overflow-hidden rounded-lg border" data-testid="drive-preview" data-kind={kind}>
    <div
      class="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="drive-editor-status-bar"
    >
      <span class="flex-1"
        >{mode.kind === 'editing'
          ? 'Editing'
          : mode.kind === 'opening'
            ? 'Opening…'
            : 'Read-only'}</span
      >
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

  <RevisionsPanel
    {fileId}
    {kind}
    revisions={revs}
    {authors}
    canRestore={mode.kind === 'editing'}
    onrestore={restore}
  />
</div>
