<script lang="ts">
  import type { SentView, ShareItemView } from '../../../../modules/contribute/share/service'
  import type { ContributionDto, ContributionStatus } from '../../../../modules/contribute/types'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronUp from '@lucide/svelte/icons/chevron-up'
  import { BOARD_TABS, inTab, nextVote, tabCounts, type BoardTab } from '$lib/contribute/board'
  import type { ContributeClient } from '$lib/contribute/client'
  import { AREA_LABEL, KIND_LABEL, STATUS_LABEL } from '$lib/contribute/labels'
  import { SHARE_STATE_LABEL } from '$lib/contribute/share-fields'
  import { appendVoiceTranscript } from '$lib/voice/transcribe-voice-clip'
  import VoiceDictation from '$lib/voice/voice-dictation.svelte'
  import { CONTRIBUTION_STATUSES } from '../../../../modules/contribute/types'

  /**
   * The Contribute board (Eigen's board tabs): Requested · In progress ·
   * Shipped, most wanted first. Everyone votes (a second click takes the vote
   * back; shipped is closed). The owner and admins move a proposal along and
   * leave the note people read — the agent does the same through the tools.
   * Changes show at once, then the page reloads the server's truth.
   *
   * The owner and admins also see each proposal's sharing with the
   * eigenEnterprise makers (Waiting · Shared · Not shared · Failed), the exact
   * payload ("Show what was sent") and can stop one ("Don't share").
   */
  type Props = {
    proposals: ContributionDto[]
    canManage: boolean
    /** Sharing state per proposal id; null when this person does not manage the board. */
    sharing: Record<string, ShareItemView> | null
    client: Pick<ContributeClient, 'vote' | 'update' | 'sentPayload' | 'dontShare'>
    /** Something changed: reload the board from the server. */
    onchanged: () => Promise<void>
  }

  let { proposals, canManage, sharing, client, onchanged }: Props = $props()

  let tab = $state<BoardTab>('requested')
  /** This person's latest change per proposal, shown until the reload lands. */
  let overrides = $state<Record<string, ContributionDto>>({})
  let busy = $state<string | null>(null)
  let noteVoiceActive = $state(false)
  let error = $state<string | null>(null)
  let editingNote = $state<{ id: string; text: string } | null>(null)

  /** "Show what was sent", opened per proposal. */
  let sentOpen = $state<Record<string, SentView>>({})
  /** This person's "Don't share", shown until the reload lands. */
  let shareOverrides = $state<Record<string, ShareItemView>>({})

  const shown = $derived(proposals.map((p) => overrides[p.id] ?? p))
  const counts = $derived(tabCounts(shown))
  const rows = $derived(inTab(shown, tab))

  const TAB_LABEL: Record<BoardTab, string> = { requested: 'Requested', in_progress: 'In progress', shipped: 'Shipped' }
  const EMPTY: Record<BoardTab, string> = {
    requested: 'Nothing requested yet. Use Contribute at the top right to propose an improvement.',
    in_progress: 'Nothing in progress right now.',
    shipped: 'Nothing shipped from the board yet.',
  }
  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

  async function run(id: string, act: () => Promise<ContributionDto>): Promise<void> {
    busy = id
    error = null
    try {
      overrides[id] = await act()
      await onchanged()
      delete overrides[id]
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = null
    }
  }

  function vote(p: ContributionDto, clicked: -1 | 1): void {
    void run(p.id, () => client.vote(p.id, nextVote(p.myVote, clicked)))
  }

  function setStatus(p: ContributionDto, status: ContributionStatus): void {
    if (status !== p.status) void run(p.id, () => client.update(p.id, { status }))
  }

  async function toggleSent(id: string): Promise<void> {
    if (sentOpen[id]) {
      delete sentOpen[id]
      return
    }
    busy = id
    error = null
    try {
      sentOpen[id] = await client.sentPayload(id)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = null
    }
  }

  async function dontShare(id: string): Promise<void> {
    busy = id
    error = null
    try {
      shareOverrides[id] = await client.dontShare(id)
      delete sentOpen[id]
      await onchanged()
      delete shareOverrides[id]
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = null
    }
  }

  function saveNote(p: ContributionDto): void {
    if (!editingNote) return
    const text = editingNote.text.trim()
    editingNote = null
    if (text === (p.note ?? '')) return
    void run(p.id, () => client.update(p.id, { note: text === '' ? null : text }))
  }
</script>

<div class="flex flex-col gap-4" data-testid="contribute-board">
  <div class="flex gap-1 border-b border-border" role="tablist" aria-label="Board">
    {#each BOARD_TABS as t (t)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === t}
        class="-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm {tab === t
          ? 'border-primary font-medium text-foreground'
          : 'border-transparent text-foreground/60 hover:text-foreground'}"
        onclick={() => (tab = t)}
        data-testid="contribute-tab-{t}"
      >
        {TAB_LABEL[t]} <span class="text-foreground/50">{counts[t]}</span>
      </button>
    {/each}
  </div>

  {#if error}
    <p class="text-sm text-destructive" role="alert">{error}</p>
  {/if}

  {#if rows.length === 0}
    <p class="py-10 text-center text-sm text-foreground/60">{EMPTY[tab]}</p>
  {:else}
    <ul class="divide-y divide-border rounded-md border border-border">
      {#each rows as p (p.id)}
        {@const closed = p.status === 'shipped'}
        {@const share = shareOverrides[p.id] ?? sharing?.[p.id]}
        <li class="flex gap-3 p-3" data-testid="contribute-row">
          <div class="flex w-9 shrink-0 flex-col items-center" aria-label="Votes">
            <button
              type="button"
              class="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-primary/[0.06] disabled:cursor-default disabled:opacity-40 {p.myVote === 1 ? 'text-primary' : 'text-foreground/50'}"
              aria-label="Vote up"
              aria-pressed={p.myVote === 1}
              disabled={closed || busy === p.id}
              onclick={() => vote(p, 1)}
            >
              <ChevronUp class="size-4" aria-hidden="true" />
            </button>
            <span class="text-sm font-medium tabular-nums" data-testid="contribute-score">{p.score}</span>
            <button
              type="button"
              class="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-primary/[0.06] disabled:cursor-default disabled:opacity-40 {p.myVote === -1 ? 'text-primary' : 'text-foreground/50'}"
              aria-label="Vote down"
              aria-pressed={p.myVote === -1}
              disabled={closed || busy === p.id}
              onclick={() => vote(p, -1)}
            >
              <ChevronDown class="size-4" aria-hidden="true" />
            </button>
          </div>

          <div class="min-w-0 flex-1">
            <p class="text-sm whitespace-pre-line [overflow-wrap:anywhere]">{p.title}</p>
            <p class="mt-1 text-xs text-foreground/55">
              {KIND_LABEL[p.kind]} · {AREA_LABEL[p.area]} · {p.own ? 'you' : p.authorName} · {dateFmt.format(new Date(p.createdAt))}
              {#if p.shippedAt}· shipped {dateFmt.format(new Date(p.shippedAt))}{/if}
            </p>
            {#if editingNote?.id === p.id}
              <div class="mt-2 flex flex-col gap-2">
                <label class="sr-only" for="note-{p.id}">Note</label>
                <textarea
                  id="note-{p.id}"
                  rows="2"
                  maxlength="1000"
                  class="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-ring"
                  bind:value={editingNote.text}
                ></textarea>
                <div class="flex items-center gap-3">
                  {#if !noteVoiceActive}
                    <button type="button" class="cursor-pointer text-xs font-medium text-primary" onclick={() => saveNote(p)}>Save note</button>
                    <button type="button" class="cursor-pointer text-xs text-foreground/60" onclick={() => (editingNote = null)}>Cancel</button>
                  {/if}
                  <VoiceDictation
                    bind:active={noteVoiceActive}
                    class={noteVoiceActive ? '' : 'ml-auto'}
                    testid="contribute-note-voice"
                    ontranscript={(t) => {
                      if (editingNote) editingNote.text = appendVoiceTranscript(editingNote.text, t)
                    }}
                  />
                </div>
              </div>
            {:else if p.note}
              <p class="mt-2 rounded-md bg-primary/[0.04] px-2.5 py-1.5 text-xs text-foreground/80" data-testid="contribute-note">
                {p.note}
              </p>
            {/if}
            {#if share}
              <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="contribute-sharing">
                <span
                  class="rounded-full px-2 py-0.5 text-[11px] {share.state === 'failed'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-primary/[0.06] text-foreground/70'}"
                  data-testid="contribute-share-state"
                  >{SHARE_STATE_LABEL[share.state]}{share.withdrawing ? ' · being withdrawn' : ''}</span
                >
                {#if share.error}
                  <span class="text-foreground/60 [overflow-wrap:anywhere]" data-testid="contribute-share-error">{share.error}</span>
                {/if}
                <button
                  type="button"
                  class="cursor-pointer text-foreground/50 hover:text-foreground"
                  disabled={busy === p.id}
                  onclick={() => void toggleSent(p.id)}>{sentOpen[p.id] ? 'Hide what was sent' : 'Show what was sent'}</button
                >
                {#if share.state !== 'not_shared'}
                  <button
                    type="button"
                    class="cursor-pointer text-foreground/50 hover:text-destructive"
                    disabled={busy === p.id}
                    onclick={() => void dontShare(p.id)}>Don't share</button
                  >
                {/if}
              </div>
              {#if sentOpen[p.id]}
                {@const sent = sentOpen[p.id]}
                <div class="mt-2 rounded-md border border-border p-2 text-xs" data-testid="contribute-sent">
                  {#if sent.payload}
                    <p class="text-foreground/60">
                      {sent.isOnHub
                        ? 'Exactly what the eigenEnterprise makers have:'
                        : 'What the next update to the makers carries (the last one sent differs):'}
                    </p>
                    <pre
                      class="mt-1 overflow-x-auto text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]"
                      data-testid="contribute-sent-payload">{JSON.stringify(sent.payload, null, 2)}</pre>
                  {:else}
                    <p class="text-foreground/60">Nothing has been prepared or sent for this proposal.</p>
                  {/if}
                </div>
              {/if}
            {/if}
            {#if canManage && editingNote?.id !== p.id}
              <button
                type="button"
                class="mt-1.5 cursor-pointer text-xs text-foreground/50 hover:text-foreground"
                onclick={() => (editingNote = { id: p.id, text: p.note ?? '' })}>{p.note ? 'Edit note' : 'Add a note'}</button
              >
            {/if}
          </div>

          {#if canManage}
            <div class="shrink-0">
              <label class="sr-only" for="status-{p.id}">Status</label>
              <select
                id="status-{p.id}"
                class="h-8 rounded-md border border-input bg-background px-2 text-xs"
                value={p.status}
                disabled={busy === p.id}
                onchange={(e) => setStatus(p, (e.currentTarget as HTMLSelectElement).value as ContributionStatus)}
              >
                {#each CONTRIBUTION_STATUSES as s (s)}<option value={s}>{STATUS_LABEL[s]}</option>{/each}
              </select>
            </div>
          {:else}
            <span class="shrink-0 self-start rounded-full bg-primary/[0.06] px-2 py-0.5 text-[11px] text-foreground/70">{STATUS_LABEL[p.status]}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
