<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import CircleSlash from '@lucide/svelte/icons/circle-slash'
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle'
  import Wrench from '@lucide/svelte/icons/wrench'
  import XIcon from '@lucide/svelte/icons/x'
  import { toolStepLabel, type ToolStepStatus } from '$lib/tool-steps/summary'

  /**
   * One tool the assistant ran (proposal 6b91931f), as a quiet, rounded step: the tool in
   * words, its state, and — opened — the short input and result summaries the harness sent
   * (secret-free, $lib/tool-steps/summary) plus the tool's own name. The side panel's chat
   * and the conversation page both render steps with it.
   */
  type Props = {
    /** The registry tool that ran (e.g. memory.capture_thought). */
    tool: string
    /** null: a step stored before steps recorded how they ended. */
    status: ToolStepStatus | null
    inputSummary?: string | null
    resultSummary?: string | null
    /** false where the surface has no result to show (the run page's feed carries none). */
    showResult?: boolean
    testid?: string
  }

  let {
    tool,
    status,
    inputSummary = null,
    resultSummary = null,
    showResult = true,
    testid = 'tool-step',
  }: Props = $props()

  const label = $derived(toolStepLabel(tool))
  const stateText: Record<ToolStepStatus, string> = {
    running: 'Running',
    done: 'Done',
    failed: 'Failed',
    stopped: 'Stopped before it finished',
  }
</script>

<details
  class="group/step my-1 min-w-0 rounded-xl border border-border bg-card text-card-foreground"
  data-testid={testid}
  data-status={status ?? 'unknown'}
>
  <summary
    class="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-1.5 text-[13px] select-none hover:bg-muted/60 [&::-webkit-details-marker]:hidden"
  >
    <span class="grid size-5 shrink-0 place-items-center rounded-full bg-muted" aria-hidden="true">
      {#if status === 'running'}
        <LoaderCircleIcon class="size-3 animate-spin text-muted-foreground" strokeWidth={2} />
      {:else if status === 'done'}
        <CheckIcon class="size-3 text-success" strokeWidth={2.25} />
      {:else if status === 'failed'}
        <XIcon class="size-3 text-destructive" strokeWidth={2.25} />
      {:else if status === 'stopped'}
        <CircleSlash class="size-3 text-muted-foreground" strokeWidth={2} />
      {:else}
        <Wrench class="size-3 text-muted-foreground" strokeWidth={2} />
      {/if}
    </span>
    <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span class="shrink-0 font-medium text-foreground" data-testid="{testid}-title">{label.title}</span>
      {#if label.area}
        <span class="shrink-0 text-muted-foreground">· {label.area}</span>
      {/if}
      {#if inputSummary}
        <span class="min-w-0 truncate text-muted-foreground" data-testid="{testid}-input-inline"
          >{inputSummary}</span
        >
      {/if}
    </span>
    {#if status}
      <span
        class={['shrink-0', status === 'failed' ? 'text-destructive' : 'text-muted-foreground']}
        data-testid="{testid}-state">{status === 'stopped' ? 'Stopped' : stateText[status]}</span
      >
      <span class="sr-only">{stateText[status]}</span>
    {/if}
    <ChevronRight
      class="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/step:rotate-90"
      aria-hidden="true"
    />
  </summary>
  <dl
    class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-[13px]"
    data-testid="{testid}-details"
  >
    <dt class="text-muted-foreground">Tool</dt>
    <dd class="min-w-0 font-mono break-all text-foreground">{tool}</dd>
    <dt class="text-muted-foreground">Input</dt>
    <dd class="min-w-0 wrap-break-word text-foreground">{inputSummary ?? 'None'}</dd>
    {#if showResult}
    <dt class="text-muted-foreground">Result</dt>
    <dd
      class={['min-w-0 wrap-break-word', status === 'failed' ? 'text-destructive' : 'text-foreground']}
      data-testid="{testid}-result"
    >
      {#if status === 'running'}
        Still running…
      {:else if resultSummary}
        {resultSummary}
      {:else if status === 'stopped'}
        The reply ended before this tool did.
      {:else if status === null}
        Not recorded.
      {:else}
        Nothing came back.
      {/if}
    </dd>
    {/if}
  </dl>
</details>
