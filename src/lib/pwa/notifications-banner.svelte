<script lang="ts">
  import BellRing from '@lucide/svelte/icons/bell-ring'
  import X from '@lucide/svelte/icons/x'
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { postSubscribe, subscribeToPush } from '$lib/push/client'
  import { pushPromptState, readPushEnvironment, type PushPromptState } from './push-prompt'

  /**
   * "Notifications on this device" for Messages: turn push on here, or — in an
   * iPhone browser tab, where push only exists for the installed app — how to
   * install it. Hidden once on, where unsupported, or after "Not now" (per
   * device and per state, so a later state still shows).
   */

  let promptState = $state<PushPromptState | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let dismissed = $state(false)

  const dismissKey = (s: PushPromptState) => `eigenenterprise:push-banner-dismissed:${s}`

  function readDismissed(s: PushPromptState): boolean {
    try {
      return localStorage.getItem(dismissKey(s)) === '1'
    } catch {
      return false
    }
  }

  function dismiss() {
    dismissed = true
    if (!promptState) return
    try {
      localStorage.setItem(dismissKey(promptState), '1')
    } catch (err) {
      console.error('[pwa] could not remember the dismissed banner', err)
    }
  }

  async function turnOn() {
    busy = true
    error = null
    try {
      await postSubscribe(await subscribeToPush())
      promptState = 'on'
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      promptState = pushPromptState(await readPushEnvironment())
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void readPushEnvironment().then((env) => {
      promptState = pushPromptState(env)
      dismissed = readDismissed(promptState)
    })
  })

  const visible = $derived(
    !dismissed && (promptState === 'ask' || promptState === 'install-first' || promptState === 'denied'),
  )
</script>

{#if visible}
  <div
    class="mx-2 mt-3 flex gap-2.5 rounded-lg border border-border bg-background p-3 text-[13px] shadow-xs"
    data-testid="push-banner"
    data-state={promptState}
  >
    <BellRing class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      {#if promptState === 'ask'}
        <p class="font-medium">Get notified on this device</p>
        <p class="mt-0.5 text-muted-foreground">Direct messages, @mentions and replies to your threads.</p>
        <Button size="sm" class="mt-2" disabled={busy} onclick={turnOn} data-testid="push-banner-enable">
          {busy ? 'Turning on…' : 'Turn on notifications'}
        </Button>
      {:else if promptState === 'install-first'}
        <p class="font-medium">Install the app for notifications</p>
        <p class="mt-0.5 text-muted-foreground">
          On iPhone and iPad, tap Share, then <span class="font-medium text-foreground">Add to Home Screen</span>, and
          open Messages from there.
        </p>
      {:else if promptState === 'denied'}
        <p class="font-medium">Notifications are blocked</p>
        <p class="mt-0.5 text-muted-foreground">Allow notifications for this site in your browser's settings to get messages here.</p>
      {/if}
      {#if error}<p class="mt-2 text-destructive" role="alert" data-testid="push-banner-error">{error}</p>{/if}
    </div>
    <button
      type="button"
      class="-mt-1 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-foreground/50 hover:text-foreground"
      aria-label="Not now"
      title="Not now"
      data-testid="push-banner-dismiss"
      onclick={dismiss}><X class="size-3.5" aria-hidden="true" /></button
    >
  </div>
{/if}
