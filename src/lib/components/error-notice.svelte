<script lang="ts">
  import type { Snippet } from 'svelte'
  import CopyAgentInstructions from '$lib/components/copy-agent-instructions.svelte'
  import type { AgentReport } from '$lib/errors/agent-report'
  import { cn } from '$lib/utils'

  /**
   * The one error notice (owner, 2026-11-21): a plain sentence for the person
   * and a "Copy agent instructions" button for a coding or ops agent — what
   * was attempted, the tool, the redacted input, the error code + details,
   * the cause and the next steps. `agent` is the server's report
   * (`ErrorReport.agent`); without one (a browser-side failure) the brief
   * still says what was seen, where, when and what was being attempted.
   * Copying is a browser affordance, not a company action, so it is not a
   * registry tool.
   */
  let {
    error,
    agent = null,
    attempted,
    title,
    class: className,
    testid,
    children,
  }: {
    /** The sentence for the person. */
    error: string
    agent?: AgentReport | null
    /** What the page was doing, when there is no server report. */
    attempted?: string
    /** An optional heading above the sentence. */
    title?: string
    class?: string
    testid?: string
    children?: Snippet
  } = $props()
</script>

<div
  class={cn('flex min-w-0 flex-col items-start gap-1 text-sm', className)}
  data-slot="error-notice"
  data-testid={testid}
>
  <div role="alert" class="text-red-600">
    {#if title}<p class="font-medium">{title}</p>{/if}
    <p>{error}</p>
  </div>
  {@render children?.()}
  <CopyAgentInstructions {error} {agent} {attempted} />
</div>
