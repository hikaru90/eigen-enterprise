<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import Copy from '@lucide/svelte/icons/copy'
  import { agentInstructions, type AgentReport } from '$lib/errors/agent-report'
  import { cn } from '$lib/utils'

  /**
   * "Copy agent instructions": puts a brief for a coding or ops agent on the
   * clipboard (see `agentInstructions`). The page and time are added at copy
   * time. If the browser blocks the clipboard, the brief is shown to select by
   * hand — never a silent no-op. Used by `<ErrorNotice>` and the error page.
   * A one-line hint says what the copy is for and where it goes (wish
   * 714726fe): paste it into the assistant or a coding agent and send it.
   */
  let {
    error,
    agent = null,
    attempted,
    class: className,
  }: {
    error: string
    agent?: AgentReport | null
    attempted?: string
    class?: string
  } = $props()

  const hintId = `copy-agent-hint-${Math.random().toString(36).slice(2, 10)}`
  let copied = $state(false)
  let manual = $state<string | null>(null)

  async function copy() {
    const text = agentInstructions(
      error,
      agent,
      { page: `${location.pathname}${location.search}`, at: new Date().toISOString() },
      attempted,
    )
    try {
      await navigator.clipboard.writeText(text)
      manual = null
      copied = true
      setTimeout(() => (copied = false), 2000)
    } catch {
      manual = text
    }
  }
</script>

<button
  type="button"
  class={cn(
    'inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
    className,
  )}
  onclick={copy}
  aria-describedby={hintId}
  data-testid="copy-agent-instructions"
>
  {#if copied}
    <Check class="size-3" aria-hidden="true" /> Copied
  {:else}
    <Copy class="size-3" aria-hidden="true" /> Copy agent instructions
  {/if}
</button>
<p id={hintId} class="text-xs text-muted-foreground" role="status" data-testid="copy-agent-instructions-hint">
  {#if copied}
    Copied. Now paste it into the assistant (or your coding agent) and send it.
  {:else}
    Copies a report of this error. Paste it into the assistant (or your coding agent) and send it to get it fixed.
  {/if}
</p>
{#if manual !== null}
  <p class="text-xs text-muted-foreground">
    The browser blocked copying. Select the instructions below and copy them.
  </p>
  <textarea
    readonly
    class="h-40 w-full rounded-md border border-border bg-muted/40 p-2 text-left font-mono text-xs"
    aria-label="Agent instructions">{manual}</textarea
  >
{/if}
