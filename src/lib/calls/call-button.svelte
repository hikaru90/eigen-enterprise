<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Video from '@lucide/svelte/icons/video'
  import X from '@lucide/svelte/icons/x'
  import { problemOf, type CallDto, type CallsClient } from './client'

  /**
   * The call button in a DM or channel header (plan/video-calls.md §2):
   * "Call" starts a call that rings the conversation's members; when a call
   * is already live there it says "Join" and opens that call. Refusals (e.g.
   * "Calls are not set up on this server") are shown under the button.
   */
  let {
    kind,
    contextId,
    live = null,
    client,
    onopen,
  }: {
    kind: 'dm' | 'channel'
    contextId: string
    /** The live call in this conversation, from the call feed. */
    live?: CallDto | null
    client: Pick<CallsClient, 'start'>
    /** Go to the call page. */
    onopen: (callId: string) => void
  } = $props()

  let busy = $state(false)
  let error = $state<string | null>(null)

  async function onclick() {
    error = null
    if (live) return onopen(live.id)
    busy = true
    try {
      const call = await client.start({ contextKind: kind, contextId })
      onopen(call.id)
    } catch (err) {
      error = problemOf(err).message
    } finally {
      busy = false
    }
  }
</script>

<div class="relative shrink-0">
  <button
    type="button"
    class={[
      'flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold disabled:opacity-60',
      live
        ? 'border-emerald-600/40 bg-emerald-600 text-white hover:bg-emerald-700'
        : 'border-border text-foreground hover:bg-foreground/[0.04]',
    ]}
    aria-label={live ? 'Join the call' : kind === 'dm' ? 'Start a video call' : 'Start a call in this channel'}
    title={live ? 'Join the call' : 'Video call'}
    disabled={busy}
    data-testid="messages-call"
    data-live={live ? 'true' : 'false'}
    {onclick}
  >
    {#if busy}<LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />{:else}<Video class="size-3.5" aria-hidden="true" />{/if}
    <span>{live ? 'Join' : 'Call'}</span>
  </button>
  {#if error}
    <div
      class="absolute top-full right-0 z-30 mt-1 flex w-64 items-start gap-2 rounded-lg border border-destructive/40 bg-popover p-2 text-xs shadow-lg"
      role="alert"
      data-testid="messages-call-error"
    >
      <p class="min-w-0 flex-1 text-destructive">{error}</p>
      <button type="button" class="text-muted-foreground hover:text-foreground" aria-label="Dismiss" onclick={() => (error = null)}
        ><X class="size-3.5" /></button
      >
    </div>
  {/if}
</div>
