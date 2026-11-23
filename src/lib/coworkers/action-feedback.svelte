<script lang="ts">
  import type { ActionFeedback } from './action-result'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { m } from '$lib/paraglide/messages.js'

  /** One action's answer under its form: saved, waiting for an owner's or admin's approval, or the error notice. */
  let { feedback, done, testid = 'action-feedback' }: { feedback: ActionFeedback | null; done?: string; testid?: string } =
    $props()
</script>

{#if feedback?.kind === 'done'}
  <p class="text-sm text-muted-foreground" role="status" data-testid={testid} data-kind="done">{done ?? m.coworkers_saved()}</p>
{:else if feedback?.kind === 'waiting'}
  <p class="text-sm" role="status" data-testid={testid} data-kind="waiting">{m.coworkers_waiting_for_approval()}</p>
{:else if feedback?.kind === 'error'}
  <ErrorNotice error={feedback.error} agent={feedback.agent} testid={testid} />
{/if}
