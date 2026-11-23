<script lang="ts">
  import BellOff from '@lucide/svelte/icons/bell-off'
  import BellRing from '@lucide/svelte/icons/bell-ring'
  import X from '@lucide/svelte/icons/x'
  import { onMount } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import type { ShownError } from '$lib/errors/agent-report'
  import { postSubscribe, shownPushFailure, subscribeToPush } from '$lib/push/client'
  import {
    pushPromptDismissKey,
    pushPromptState,
    readPushEnvironment,
    type PushEnvironment,
    type PushPromptState,
  } from './push-prompt'

  /**
   * "Turn on notifications on this device": turn push on here, or — in an
   * iPhone browser tab, where push only exists for the installed app — how to
   * install it. Hidden once on, where unsupported, or after "Not now" (per
   * device, per state, and apart for the installed app — see
   * pushPromptDismissKey — so a later state still shows).
   *
   * - sidebar: in Messages (the installed app opens there)
   * - floating: everywhere else in the app shell, with standaloneOnly — the
   *   home-screen app has its own permission and subscription on iPhone/iPad,
   *   so it must offer this itself (bug 87f5b9f8)
   * - inline: Settings → Account → Notifications, no "Not now"
   * - top: only while notifications are blocked — a bar pinned at the top of
   *   every signed-in page (owner, 2026-11-23), no "Not now"; it re-reads the
   *   permission when the person comes back (focus / tab visible), so it goes
   *   once they allow notifications again. Sidebar and floating leave a
   *   block to it.
   *
   * The permission prompt only ever comes from the person's tap on "Turn on"
   * (iOS refuses it otherwise): `enable` asks for it before anything else.
   */
  type Props = {
    variant?: 'sidebar' | 'floating' | 'inline' | 'top'
    /** Only in the installed app (display-mode standalone). */
    standaloneOnly?: boolean
    readEnv?: () => Promise<PushEnvironment>
    enable?: () => Promise<void>
    onenabled?: () => void
  }

  let {
    variant = 'sidebar',
    standaloneOnly = false,
    readEnv = readPushEnvironment,
    enable = async () => postSubscribe(await subscribeToPush()),
    onenabled,
  }: Props = $props()

  let promptState = $state<PushPromptState | null>(null)
  let standalone = $state(false)
  let busy = $state(false)
  let error = $state<ShownError | null>(null)
  let dismissed = $state(false)

  function readDismissed(s: PushPromptState): boolean {
    if (variant === 'inline' || variant === 'top') return false
    try {
      return localStorage.getItem(pushPromptDismissKey(s, standalone)) === '1'
    } catch {
      return false
    }
  }

  function dismiss() {
    dismissed = true
    if (!promptState) return
    try {
      localStorage.setItem(pushPromptDismissKey(promptState, standalone), '1')
    } catch (err) {
      console.error('[pwa] could not remember the dismissed banner', err)
    }
  }

  async function refresh() {
    const env = await readEnv()
    standalone = env.standalone
    promptState = pushPromptState(env)
  }

  async function turnOn() {
    busy = true
    error = null
    try {
      await enable()
      promptState = 'on'
      onenabled?.()
    } catch (err) {
      error = shownPushFailure(err)
      await refresh().catch((e) =>
        console.error('[pwa] could not re-read the notification state', e),
      )
    } finally {
      busy = false
    }
  }

  onMount(() => {
    refresh()
      .then(() => {
        if (promptState) dismissed = readDismissed(promptState)
      })
      .catch((err) => console.error('[pwa] could not read the notification state', err))
    if (variant !== 'top') return
    // Allowing notifications happens in the browser's or phone's settings, outside the page.
    const reread = () =>
      refresh().catch((err) => console.error('[pwa] could not re-read the notification state', err))
    const onVisible = () => {
      if (document.visibilityState === 'visible') reread()
    }
    window.addEventListener('focus', reread)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', reread)
      document.removeEventListener('visibilitychange', onVisible)
    }
  })

  const offered = $derived(
    variant === 'top'
      ? promptState === 'denied'
      : promptState === 'ask' ||
          promptState === 'install-first' ||
          (variant === 'inline' && promptState === 'denied'),
  )
  const visible = $derived(!dismissed && (!standaloneOnly || standalone) && offered)
</script>

{#if visible && variant === 'top'}
  <div
    class="sticky top-0 z-30 flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-2 text-[13px]"
    role="status"
    aria-label="Notifications on this device"
    data-testid="push-banner"
    data-state={promptState}
  >
    <BellOff class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <p class="min-w-0">
      <span class="font-medium">Notifications are blocked.</span>
      <span class="text-muted-foreground">
        {standalone
          ? 'Allow notifications for this app in your phone’s settings to get messages, reminders and tasks here.'
          : 'Allow notifications for this site in your browser’s settings to get messages, reminders and tasks here.'}
      </span>
    </p>
  </div>
{:else if visible}
  <div
    class={[
      'flex gap-2.5 rounded-lg border border-border bg-background p-3 text-[13px]',
      variant === 'sidebar' && 'mx-2 mt-3 shadow-xs',
      variant === 'floating' &&
        'fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 mx-auto max-w-sm shadow-lg',
    ]}
    role={variant === 'floating' ? 'region' : undefined}
    aria-label={variant === 'floating' ? 'Notifications on this device' : undefined}
    data-testid="push-banner"
    data-state={promptState}
  >
    <BellRing class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      {#if promptState === 'ask'}
        <p class="font-medium">Turn on notifications on this device</p>
        <p class="mt-0.5 text-muted-foreground">
          {variant === 'sidebar'
            ? 'Direct messages, @mentions and replies to your threads.'
            : 'Messages, reminders and tasks reach this device once notifications are on here.'}
        </p>
        <Button
          size="sm"
          class="mt-2"
          disabled={busy}
          onclick={turnOn}
          data-testid="push-banner-enable"
        >
          {busy ? 'Turning on…' : 'Turn on notifications'}
        </Button>
      {:else if promptState === 'install-first'}
        <p class="font-medium">Install the app for notifications</p>
        <p class="mt-0.5 text-muted-foreground">
          On iPhone and iPad, tap Share, then <span class="font-medium text-foreground"
            >Add to Home Screen</span
          >, and open the app from there.
        </p>
      {:else if promptState === 'denied'}
        <p class="font-medium">Notifications are blocked</p>
        <p class="mt-0.5 text-muted-foreground">
          {standalone
            ? 'Allow notifications for this app in your phone’s settings to get messages here.'
            : 'Allow notifications for this site in your browser’s settings to get messages here.'}
        </p>
      {/if}
      {#if error}
        <ErrorNotice
          class="mt-2"
          testid="push-banner-error"
          error={error.error}
          agent={error.agent}
          attempted="Turning on notifications on this device"
        />
      {/if}
    </div>
    {#if variant !== 'inline'}
      <button
        type="button"
        class="-mt-1 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
        aria-label="Not now"
        title="Not now"
        data-testid="push-banner-dismiss"
        onclick={dismiss}><X class="size-3.5" aria-hidden="true" /></button
      >
    {/if}
  </div>
{/if}
