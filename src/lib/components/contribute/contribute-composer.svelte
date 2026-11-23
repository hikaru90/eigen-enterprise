<script lang="ts">
  import ErrorNotice from '$lib/components/error-notice.svelte'
  /* eslint-disable svelte/no-navigation-without-resolve -- boardHref is resolved by the caller (resolve('/contribute')) */
  import type { ContributionCheck, ContributionDto } from '../../../../modules/contribute/types'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import type { ContributeClient } from '$lib/contribute/client'
  import { AREA_LABEL, KIND_PHRASE, STATUS_LABEL, votesLabel } from '$lib/contribute/labels'
  import { m } from '$lib/paraglide/messages.js'
  import { appendVoiceTranscript } from '$lib/voice/transcribe-voice-clip'
  import VoiceDictation from '$lib/voice/voice-dictation.svelte'
  import { CONTRIBUTION_MAX_LENGTH } from '../../../../modules/contribute/types'

  /**
   * The Make a wish composer (module `contribute`; Eigen's share bar, in the top bar's popover):
   * Send runs the board's LLM judge first — it reads kind and area and may
   * name the same request already open. Then the chorus card offers "Vote for
   * it instead" or "Mine's different"; with no duplicate the proposal is
   * shared straight away with the judged reading. An agent picks it up later
   * from the board.
   */
  type Props = {
    client: Pick<ContributeClient, 'check' | 'share' | 'vote'>
    boardHref: string
    /** The person followed the board link (the popover closes). */
    onnavigate?: () => void
    /** A proposal was shared or voted for (the board reloads). */
    onchanged?: () => void
    /** The draft. Owned by the caller: the popover unmounts the composer on an outside click. */
    text?: string
  }

  let { client, boardHref, onnavigate, onchanged, text = $bindable('') }: Props = $props()

  type Done =
    { kind: 'shared'; proposal: ContributionDto } | { kind: 'voted'; proposal: ContributionDto }

  /** The judge's answer for exactly this draft. */
  let checked = $state<{ title: string; result: ContributionCheck } | null>(null)
  let working = $state<'checking' | 'sharing' | 'voting' | null>(null)
  let done = $state<Done | null>(null)
  let error = $state<string | null>(null)
  let voiceActive = $state(false)

  const trimmed = $derived(text.trim())
  const tooLong = $derived(trimmed.length > CONTRIBUTION_MAX_LENGTH)
  const sendable = $derived(trimmed.length > 0 && !tooLong && working === null)
  const current = $derived(checked && checked.title === trimmed ? checked.result : null)
  const duplicate = $derived(current?.duplicateOf ?? null)

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  async function share(result: ContributionCheck, title: string): Promise<void> {
    working = 'sharing'
    try {
      const proposal = await client.share({ title, kind: result.kind, area: result.area })
      done = { kind: 'shared', proposal }
      text = ''
      checked = null
      onchanged?.()
    } catch (err) {
      error = message(err)
    } finally {
      working = null
    }
  }

  async function send(): Promise<void> {
    if (!sendable) return
    const title = trimmed
    error = null
    working = 'checking'
    let result: ContributionCheck
    try {
      result = await client.check(title)
    } catch (err) {
      error = message(err)
      return
    } finally {
      working = null
    }
    // the draft changed while the judge read it: wait for the next Send
    if (text.trim() !== title) return
    checked = { title, result }
    if (!result.duplicateOf) await share(result, title)
  }

  /** "Mine's different": share it anyway, with the judge's reading. */
  function shareAnyway(): void {
    if (current) void share(current, trimmed)
  }

  /** "Vote for it instead": the votes pile up behind one request. */
  async function voteInstead(): Promise<void> {
    if (!duplicate) return
    error = null
    if (duplicate.own || duplicate.myVote === 1) {
      done = { kind: 'voted', proposal: duplicate }
      text = ''
      checked = null
      return
    }
    working = 'voting'
    try {
      const proposal = await client.vote(duplicate.id, 1)
      done = { kind: 'voted', proposal }
      text = ''
      checked = null
      onchanged?.()
    } catch (err) {
      error = message(err)
    } finally {
      working = null
    }
  }

  function another(): void {
    done = null
    error = null
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void send()
    }
  }
</script>

<div class="flex flex-col gap-3" data-testid="contribute-composer">
  {#if done}
    <div class="flex flex-col gap-2" role="status" data-testid="contribute-done">
      <p class="text-sm font-medium">
        {done.kind === 'shared' ? m.wish_done_shared() : m.wish_done_voted()}
      </p>
      <p class="text-xs text-foreground/60 [overflow-wrap:anywhere]">
        {#if done.kind === 'shared'}
          {m.wish_done_reading({
            kind: KIND_PHRASE[done.proposal.kind](),
            area: AREA_LABEL[done.proposal.area](),
          })}
        {:else}
          “{done.proposal.title}” · {votesLabel(done.proposal.score)}
        {/if}
      </p>
      <div class="flex items-center gap-4 pt-1">
        <a
          href={boardHref}
          class="text-xs font-medium text-primary hover:underline"
          onclick={() => onnavigate?.()}>{m.wish_composer_see_board()}</a
        >
        <button
          type="button"
          class="cursor-pointer text-xs text-foreground/60 hover:text-foreground"
          onclick={another}>{m.wish_composer_another()}</button
        >
      </div>
    </div>
  {:else}
    <div>
      <p class="text-sm font-medium">{m.wish_composer_heading()}</p>
      <p class="mt-0.5 text-xs text-foreground/60">
        {m.wish_composer_hint()}
      </p>
      <p class="mt-1 text-[13px] text-muted-foreground" data-testid="contribute-shared-note">
        {m.wish_composer_shared_note()}
      </p>
    </div>

    {#if duplicate}
      <div
        class="rounded-md border border-border bg-primary/[0.04] p-3"
        data-testid="contribute-duplicate"
      >
        <p class="text-xs text-foreground/60">{m.wish_composer_duplicate()}</p>
        <p class="mt-1 text-sm font-medium [overflow-wrap:anywhere]">{duplicate.title}</p>
        <p class="mt-0.5 text-xs text-foreground/60">
          {votesLabel(duplicate.score)} · {STATUS_LABEL[duplicate.status]()}
        </p>
        <div class="mt-2.5 flex items-center gap-4">
          <button
            type="button"
            class="h-7 cursor-pointer rounded-full bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50"
            disabled={working !== null}
            onclick={() => void voteInstead()}
          >
            {duplicate.myVote === 1 || duplicate.own
              ? m.wish_composer_already_voted()
              : m.wish_composer_vote_instead()}
          </button>
          <button
            type="button"
            class="cursor-pointer text-xs text-foreground/70 hover:text-foreground disabled:opacity-50"
            disabled={working !== null}
            onclick={shareAnyway}
          >
            {m.wish_composer_mine_different()}
          </button>
        </div>
      </div>
    {/if}

    <label class="sr-only" for="contribute-text">{m.wish_composer_input_label()}</label>
    <textarea
      id="contribute-text"
      bind:value={text}
      onkeydown={onKeydown}
      rows="4"
      placeholder={m.wish_composer_placeholder()}
      aria-invalid={tooLong}
      disabled={working !== null}
      class="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 -ring disabled:opacity-60 aria-invalid:border-destructive"
      data-testid="contribute-input"></textarea>

    {#if tooLong}
      <p class="text-xs text-destructive">
        {m.wish_composer_too_long({ max: CONTRIBUTION_MAX_LENGTH, count: trimmed.length })}
      </p>
    {/if}
    {#if error}
      <ErrorNotice
        class="text-xs leading-relaxed"
        {error}
        attempted={m.wish_composer_attempted()}
      />
    {/if}

    <div class="flex items-center justify-between gap-3">
      {#if !voiceActive}
        <a
          href={boardHref}
          class="text-xs text-foreground/60 hover:text-foreground"
          onclick={() => onnavigate?.()}>{m.wish_composer_see_board()}</a
        >
      {/if}
      <div class={['flex items-center gap-1.5', voiceActive && 'min-w-0 flex-1']}>
        <VoiceDictation
          bind:active={voiceActive}
          disabled={working !== null}
          testid="contribute-voice"
          ontranscript={(t) => (text = appendVoiceTranscript(text, t))}
        />
        {#if !voiceActive}
          <button
            type="button"
            class="flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!sendable}
            onclick={() => void send()}
            data-testid="contribute-send"
          >
            {#if working === 'checking' || working === 'sharing'}
              <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
              {working === 'checking' ? m.wish_composer_checking() : m.wish_composer_sharing()}
            {:else}
              {m.wish_composer_send()}
            {/if}
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>
