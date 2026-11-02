<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit'
  import { onMount } from 'svelte'
  import { enhance } from '$app/forms'
  import { invalidateAll } from '$app/navigation'
  import { capture } from '$lib/analytics/posthog-client'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { ONBOARDING_GROUNDING_PUSH_DELAY_MS } from '$lib/grounding/onboarding-welcome-constants'
  import { getPushSupportState, postSubscribe, subscribeToPush } from '$lib/push/client'

  let { open }: { open: boolean } = $props()

  /** 0 welcome · 1 capture · 2 notifications */
  let step = $state(0)
  const lastStep = 2

  let pushDone = $state(false)
  let pushBusy = $state(false)
  let pushError = $state<string | null>(null)
  let pushUnsupportedReason = $state<string | null>(null)
  let welcomePushScheduled = $state(false)

  function resetOnOpen() {
    step = 0
    pushError = null
    welcomePushScheduled = false
    const support = getPushSupportState()
    if (!support.supported) {
      pushUnsupportedReason = support.reason
    } else if (support.permission === 'granted') {
      pushUnsupportedReason = null
      void (async () => {
        try {
          const json = await subscribeToPush()
          await postSubscribe(json)
          pushDone = true
          void maybeScheduleWelcomePush()
        } catch {
          // Permission granted but subscribe failed — show enable CTA.
          pushDone = false
        }
      })()
    } else {
      pushUnsupportedReason = null
      pushDone = false
    }
  }

  onMount(() => {
    if (!open) return

    resetOnOpen()
  })

  const titles = [
    'Your memory, not theirs.',
    'Just drop it in.',
    'Stay in the loop',
  ] as const
  const title = $derived(titles[step] ?? titles[0])

  async function maybeScheduleWelcomePush(): Promise<void> {
    if (welcomePushScheduled) return
    if (!pushDone) return

    const remaining = ONBOARDING_GROUNDING_PUSH_DELAY_MS
    welcomePushScheduled = true
    try {
      const res = await fetch('/api/grounding/onboarding-welcome-push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delayMs: remaining }),
      })
      if (!res.ok) {
        welcomePushScheduled = false
        const body = await res.json().catch(() => null)
        const msg =
          body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
            ? body.message
            : `Failed to schedule welcome notification (${res.status})`
        console.error('[onboarding] welcome push schedule failed', msg)
        return
      }
      capture('onboarding_welcome_push_scheduled', { delay_ms: remaining })
    } catch (e) {
      welcomePushScheduled = false
      console.error('[onboarding] welcome push schedule failed', e)
    }
  }

  async function onEnableNotifications(): Promise<void> {
    if (pushBusy) return
    pushBusy = true
    pushError = null
    try {
      const json = await subscribeToPush()
      await postSubscribe(json)
      pushDone = true
      capture('onboarding_push_enabled', {})
      void maybeScheduleWelcomePush()
    } catch (e) {
      pushError = e instanceof Error ? e.message : String(e)
    } finally {
      pushBusy = false
    }
  }

  const completeOnboardingEnhance: SubmitFunction =
    () =>
    async ({ result, update }) => {
      await update({ reset: false })
      if (result.type === 'success') {
        capture('onboarding_completed', { push_enabled: pushDone })
        await invalidateAll()
      }
    }

  const skipOnboardingEnhance: SubmitFunction =
    () =>
    async ({ result, update }) => {
      await update({ reset: false })
      if (result.type === 'success') {
        capture('onboarding_skipped', { step })
        await invalidateAll()
      }
    }
</script>

{#if open}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-5 backdrop-blur-[2px]"
    role="dialog"
    aria-modal="true"
    aria-labelledby="onboarding-title"
    aria-describedby="onboarding-desc"
  >
    <Card.Root
      class="ring-foreground/10 max-h-[90dvh] w-full max-w-md overflow-y-auto border border-border bg-card shadow-lg ring-1 rounded-xl"
    >
      <Card.Header class="space-y-2">
        <Card.Title id="onboarding-title" class="text-base">{title}</Card.Title>
        <Card.Description id="onboarding-desc" class="text-muted-foreground text-xs">
          Step {step + 1} of {lastStep + 1}
        </Card.Description>
      </Card.Header>

      <Card.Content class="space-y-3 text-sm text-card-foreground">
        {#if step === 0}
          <p class="text-xs leading-relaxed">
            Your memory shouldn't live inside one chat vendor or hyperscaler. Eigen Enterprise is yours —
            portable across every AI tool you use, not locked to theirs.
          </p>
        {:else if step === 1}
          <p class="text-xs leading-relaxed">
            Eigen Enterprise captures what's on your mind and keeps it organized and searchable. Nothing
            to file, nothing to tag.
          </p>
          <p class="text-xs leading-relaxed">
            Type it or say it. It files it away and remembers it for you — so next time you ask, it
            already knows what you knew.
          </p>
        {:else}
          <p class="text-xs leading-relaxed">
            Enable notifications so Eigen Enterprise can nudge you with a quick question after setup — and
            later for reminders and memory check-ins.
          </p>
          {#if pushDone}
            <p class="text-xs leading-relaxed text-foreground/80">
              Notifications enabled for this device.
            </p>
          {:else if pushUnsupportedReason}
            <p class="text-xs text-muted-foreground leading-relaxed">
              Push isn't available here ({pushUnsupportedReason}). You can continue and enable later
              in Settings.
            </p>
          {:else}
            {#if pushError}
              <p class="text-destructive text-xs">{pushError}</p>
            {/if}
            <div class="flex flex-col gap-2 pt-1">
              <Button
                type="button"
                class="h-11 w-full rounded-[4px] text-sm font-medium"
                disabled={pushBusy}
                onclick={() => void onEnableNotifications()}
              >
                {pushBusy ? 'Enabling…' : 'Enable notifications'}
              </Button>
              <form
                method="post"
                action="?/completeOnboarding"
                use:enhance={completeOnboardingEnhance}
                class="w-full"
              >
                <Button
                  type="submit"
                  variant="ghost"
                  class="h-8 w-full rounded-[4px] text-xs text-muted-foreground"
                  onclick={() => capture('onboarding_push_skipped', {})}
                >
                  Continue without notifications
                </Button>
              </form>
            </div>
          {/if}
        {/if}
      </Card.Content>

      <Card.Footer
        class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4"
      >
        <div class="flex min-w-0 flex-1 items-center gap-2">
          {#if step > 0}
            <Button
              type="button"
              variant="outline"
              class="rounded-[4px] text-xs"
              onclick={() => (step -= 1)}
            >
              Back
            </Button>
          {/if}
          <form method="post" action="?/skipOnboarding" use:enhance={skipOnboardingEnhance}>
            <Button
              type="submit"
              variant="ghost"
              class="rounded-[4px] text-xs text-muted-foreground"
            >
              Skip for now
            </Button>
          </form>
        </div>

        {#if step < 2}
          <Button type="button" class="rounded-[4px] text-xs" onclick={() => (step += 1)}
            >Next</Button
          >
        {:else if pushDone || pushUnsupportedReason}
          <form
            method="post"
            action="?/completeOnboarding"
            use:enhance={completeOnboardingEnhance}
          >
            <Button type="submit" class="rounded-[4px] text-xs">Start capturing →</Button>
          </form>
        {/if}
      </Card.Footer>
    </Card.Root>
  </div>
{/if}
