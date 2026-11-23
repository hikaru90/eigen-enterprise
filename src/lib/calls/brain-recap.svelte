<script lang="ts">
  import type { BrainClient } from './client'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import type { ShownError } from '$lib/errors/agent-report'
  import { shownProblemOf } from './client'

  /**
   * After a call, for whoever switched the Company Brain on: an offer, not a
   * post. The recap of what it heard is generated only when they click, and
   * shown to them here — nobody else gets it. `tone`: the dark call view or
   * a light page (the transcript). `importHref`: once written, "Import into
   * the brain" drafts it into the assistant chat (recap-import.ts) — the
   * assistant proposes notes, tasks and projects and saves after the person's
   * OK there; null (the Assistant is off): no offer.
   */
  let {
    callId,
    client,
    tone = 'light',
    importHref = null,
  }: {
    callId: string
    client: Pick<BrainClient, 'brainRecap'>
    tone?: 'dark' | 'light'
    importHref?: string | null
  } = $props()

  let recap = $state<string | null>(null)
  let busy = $state(false)
  let problem = $state<ShownError | null>(null)

  async function generate() {
    busy = true
    problem = null
    try {
      recap = await client.brainRecap(callId)
    } catch (err) {
      problem = shownProblemOf(err)
    } finally {
      busy = false
    }
  }
</script>

<div class="flex w-full flex-col gap-2 text-left" data-testid="call-brain-recap">
  {#if recap}
    <div
      class={[
        'rounded-lg p-4 text-sm',
        tone === 'dark' ? 'bg-white/5 text-neutral-50' : 'bg-white text-foreground',
      ]}
    >
      <p class={['text-xs', tone === 'dark' ? 'text-neutral-400' : 'text-muted-foreground']}>
        Recap from the Company Brain · only you see it
      </p>
      <p class="mt-2 whitespace-pre-wrap" data-testid="call-brain-recap-text">{recap}</p>
      {#if importHref}
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <!-- eslint-disable svelte/no-navigation-without-resolve -- a query-only (?prefill=) or root draft link the page builds -->
          <a
            href={importHref}
            class={[
              'inline-flex h-8 items-center rounded-md px-3 text-xs font-semibold',
              tone === 'dark'
                ? 'bg-white text-neutral-900 hover:bg-white/90'
                : 'bg-foreground text-background hover:bg-foreground/90',
            ]}
            data-testid="call-brain-recap-import">Import into the brain</a
          >
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
          <span class={['text-xs', tone === 'dark' ? 'text-neutral-400' : 'text-muted-foreground']}
            >The assistant lists notes, tasks and projects first — nothing is saved until you say OK.</span
          >
        </div>
      {/if}
    </div>
  {:else}
    <p class={['text-sm', tone === 'dark' ? 'text-neutral-400' : 'text-muted-foreground']}>
      You switched the Company Brain on in this call. It can recap what it heard — for you only,
      nothing is posted.
    </p>
    <button
      type="button"
      class={[
        'h-9 w-fit rounded-md px-4 text-sm font-semibold disabled:opacity-50',
        tone === 'dark'
          ? 'bg-white text-neutral-900 hover:bg-white/90'
          : 'bg-foreground text-background hover:bg-foreground/90',
      ]}
      disabled={busy}
      data-testid="call-brain-recap-button"
      onclick={generate}>{busy ? 'Writing the recap…' : 'Recap this call'}</button
    >
  {/if}
  {#if problem}
    <ErrorNotice
      testid="call-brain-recap-problem"
      error={problem.error}
      agent={problem.agent}
      attempted="Writing the Company Brain recap of a call"
    />
  {/if}
</div>
