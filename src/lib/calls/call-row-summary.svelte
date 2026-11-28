<script lang="ts">
  import type { BrainClient } from './client'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import type { ShownError } from '$lib/errors/agent-report'
  import { shownProblemOf } from './client'

  /**
   * A /calls row's summary (wish 397dfda6): for whoever switched the Company
   * Brain on in the call, "Make summary" writes the recap of what it heard
   * (calls.brain_recap, kept for them) and the row shows it from then on —
   * collapsed under "Summary". Only they see it.
   */
  let {
    callId,
    recap: initial,
    client,
  }: { callId: string; recap: string | null; client: Pick<BrainClient, 'brainRecap'> } = $props()

  // svelte-ignore state_referenced_locally
  let recap = $state<string | null>(initial)
  let open = $state(false)
  let busy = $state(false)
  let problem = $state<ShownError | null>(null)

  async function make() {
    busy = true
    problem = null
    try {
      recap = await client.brainRecap(callId)
      open = true
    } catch (err) {
      problem = shownProblemOf(err)
    } finally {
      busy = false
    }
  }
</script>

<div class="flex w-full flex-col gap-2" data-testid="calls-summary">
  {#if recap}
    <button
      type="button"
      class="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      aria-expanded={open}
      data-testid="calls-summary-toggle"
      onclick={() => (open = !open)}
      ><Sparkles class="size-3.5" aria-hidden="true" />{open ? 'Hide summary' : 'Summary'}</button
    >
    {#if open}
      <p
        class="rounded-lg bg-foreground/[0.04] p-3 text-sm whitespace-pre-wrap"
        data-testid="calls-summary-text"
      >
        {recap}
      </p>
      <p class="text-xs text-muted-foreground">From the Company Brain · only you see it</p>
    {/if}
  {:else}
    <button
      type="button"
      class="inline-flex h-7 w-fit items-center gap-1 rounded-full bg-foreground/[0.06] px-2.5 text-xs font-medium hover:bg-foreground/[0.1] disabled:opacity-50"
      disabled={busy}
      data-testid="calls-summary-make"
      onclick={make}
      ><Sparkles class="size-3.5" aria-hidden="true" />{busy
        ? 'Writing the summary…'
        : 'Make summary'}</button
    >
  {/if}
  {#if problem}
    <ErrorNotice
      testid="calls-summary-problem"
      error={problem.error}
      agent={problem.agent}
      attempted="Writing the Company Brain summary of a call"
    />
  {/if}
</div>
