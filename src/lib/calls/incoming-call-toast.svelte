<script lang="ts">
  import type { LiveCalls } from './live-calls.svelte'
  import Phone from '@lucide/svelte/icons/phone'
  import PhoneOff from '@lucide/svelte/icons/phone-off'
  import X from '@lucide/svelte/icons/x'
  import { onDestroy, onMount } from 'svelte'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { openCallTab, type OpenWindow } from './call-tab'
  import { problemOf, type CallDto, type CallsClient } from './client'
  import { webAudioRinger, type Ringer } from './ringtone'

  /**
   * "Ring everywhere" (plan/video-calls.md owner decision 5): mounted once in
   * the nucleus layout. Shows every call ringing for me with Accept / Decline
   * and plays the ringtone while anything rings. The feed (LiveCalls) hides a
   * call when it stops ringing for me — answered elsewhere, cancelled, missed.
   *
   * Accept opens the call in its own tab (call-tab.ts) right in the click and
   * the call tab answers it (ActiveCall accepts before joining): a refused
   * accept ("this call is over") is shown there, in the tab I am looking at.
   * Here the ring stops at once. A blocked tab is said here and the call keeps
   * ringing, so Accept can be tried again once pop-ups are allowed.
   */
  let {
    live,
    client,
    inCall = null,
    ringer = webAudioRinger(),
    open,
  }: {
    live: LiveCalls
    client: Pick<CallsClient, 'decline'>
    /** The call I am in right now, in any tab (one call at a time: another one cannot be accepted). */
    inCall?: string | null
    ringer?: Ringer
    /** window.open (a spec's fake in component specs). */
    open?: OpenWindow
  } = $props()

  let busy = $state<Record<string, 'decline'>>({})
  /** A refused decline or a blocked tab stays visible until dismissed, even after the call stops ringing. */
  let failed = $state<Array<{ call: CallDto; message: string }>>([])

  const ringing = $derived(live.ringing)

  function syncRingtone() {
    if (live.ringing.length > 0) ringer.start()
    else ringer.stop()
  }

  let unsubscribe = () => {}
  onMount(() => {
    unsubscribe = live.subscribe(syncRingtone)
    syncRingtone()
  })
  onDestroy(() => {
    unsubscribe()
    ringer.stop()
  })

  const caller = (c: CallDto) => c.startedByName
  const where = (c: CallDto) => (c.contextKind === 'dm' ? 'Video call' : c.contextKind === 'channel' ? `Call in ${c.title}` : c.title)

  const blocked = (c: CallDto) => inCall !== null && inCall !== c.id

  const fail = (c: CallDto, err: unknown) =>
    (failed = [...failed.filter((f) => f.call.id !== c.id), { call: c, message: problemOf(err).message }])

  /** Synchronous on purpose: the tab must open within the click. */
  function accept(c: CallDto) {
    if (busy[c.id] || blocked(c)) return
    try {
      openCallTab(c.id, open)
    } catch (err) {
      fail(c, err)
      return
    }
    failed = failed.filter((f) => f.call.id !== c.id)
    live.dismiss(c.id)
    syncRingtone()
  }

  async function decline(c: CallDto) {
    if (busy[c.id]) return
    busy = { ...busy, [c.id]: 'decline' }
    try {
      await client.decline(c.id)
      live.dismiss(c.id)
      syncRingtone()
    } catch (err) {
      live.dismiss(c.id)
      syncRingtone()
      fail(c, err)
    } finally {
      busy = Object.fromEntries(Object.entries(busy).filter(([id]) => id !== c.id))
    }
  }
</script>

{#if ringing.length > 0 || failed.length > 0}
  <div
    class="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 p-3 sm:inset-x-auto sm:top-auto sm:right-0 sm:bottom-0 sm:items-end sm:p-5"
    data-testid="incoming-calls"
  >
    {#each ringing as c (c.id)}
      <div
        class="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
        role="alertdialog"
        aria-label="Incoming call from {caller(c)}"
        data-testid="incoming-call"
        data-call-id={c.id}
      >
        <span class="relative shrink-0">
          <UserAvatar name={caller(c)} size="lg" round />
          <span class="absolute -right-0.5 -bottom-0.5 grid size-5 place-items-center rounded-full bg-emerald-600 text-white ring-2 ring-popover">
            <Phone class="size-3 animate-pulse" aria-hidden="true" />
          </span>
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold" data-testid="incoming-call-caller">{caller(c)}</p>
          <p class="truncate text-xs text-muted-foreground" data-testid="incoming-call-where">{where(c)}</p>
          {#if blocked(c)}
            <p class="text-xs font-medium text-foreground" data-testid="incoming-call-busy">You're already in a call. Hang up to answer this one.</p>
          {/if}
        </div>
        <button
          type="button"
          class="grid size-10 shrink-0 place-items-center rounded-full bg-destructive text-white hover:bg-destructive/90 disabled:opacity-60"
          aria-label="Decline"
          title="Decline"
          disabled={busy[c.id] !== undefined}
          data-testid="incoming-call-decline"
          onclick={() => decline(c)}><PhoneOff class="size-4" /></button
        >
        <button
          type="button"
          class="grid size-10 shrink-0 place-items-center rounded-full bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
          aria-label="Accept"
          title="Accept"
          disabled={busy[c.id] !== undefined || blocked(c)}
          data-testid="incoming-call-accept"
          onclick={() => accept(c)}><Phone class="size-4" /></button
        >
      </div>
    {/each}
    {#each failed as f (f.call.id)}
      <div
        class="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-destructive/40 bg-popover p-3 text-popover-foreground shadow-lg"
        role="alert"
        data-testid="incoming-call-error"
      >
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold">Call from {caller(f.call)}</p>
          <p class="text-xs text-destructive">{f.message}</p>
        </div>
        <button
          type="button"
          class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Dismiss"
          onclick={() => (failed = failed.filter((x) => x.call.id !== f.call.id))}><X class="size-4" /></button
        >
      </div>
    {/each}
  </div>
{/if}
