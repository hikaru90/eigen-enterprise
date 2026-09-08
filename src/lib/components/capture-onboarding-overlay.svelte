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

  let {
    open,
    providerReady = true,
    byokUiEnabled = true,
  }: { open: boolean; providerReady?: boolean; byokUiEnabled?: boolean } = $props()

  type StepId = 'welcome' | 'capture' | 'provider' | 'notifications'

  // Frozen at instantiation: the flow must not reshape mid-run even if the save below
  // flips provider readiness in the load data. Reopening the overlay remounts it.
  const flowSteps: StepId[] = [
    'welcome',
    'capture',
    ...(providerReady ? [] : (['provider'] as StepId[])),
    'notifications',
  ]

  let stepIndex = $state(0)
  const stepId = $derived(flowSteps[stepIndex] ?? 'notifications')
  const lastStepIndex = flowSteps.length - 1

  let pushDone = $state(false)
  let pushBusy = $state(false)
  let pushError = $state<string | null>(null)
  let pushUnsupportedReason = $state<string | null>(null)
  let welcomePushScheduled = $state(false)

  let providerChoice = $state<'openrouter' | 'eurouter'>('openrouter')
  let providerSaved = $state(false)
  let providerError = $state<string | null>(null)
  let providerBaseUrl = $state('')
  let providerApiKey = $state('')
  let providerModelChat = $state('')
  let providerModelEmbedding = $state('')
  let providerRuleChat = $state('')
  let providerRuleEmbedding = $state('')

  function resetOnOpen() {
    stepIndex = 0
    pushError = null
    welcomePushScheduled = false
    providerError = null
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

  const title = $derived(
    stepId === 'welcome'
      ? 'Your memory, not theirs.'
      : stepId === 'capture'
        ? 'Just drop it in.'
        : stepId === 'provider'
          ? 'Connect your AI provider.'
          : 'Stay in the loop',
  )

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

  const saveProviderEnhance: SubmitFunction = () => async ({ result, update }) => {
    if (result.type === 'success') {
      providerSaved = true
      providerError = null
      capture('onboarding_provider_saved', { provider: providerChoice })
    } else if (result.type === 'failure') {
      const data = result.data as { providerMessage?: string } | undefined
      providerError = data?.providerMessage ?? 'Unable to save provider configuration.'
    }
    await update({ reset: false })
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
        capture('onboarding_skipped', { step: stepId })
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
      class="ring-foreground/10 max-h-[90dvh] w-full max-w-md overflow-y-auto border border-black/10 bg-card shadow-lg ring-1 dark:border-white/20"
    >
      <Card.Header class="space-y-2">
        <Card.Title id="onboarding-title" class="text-base">{title}</Card.Title>
        <Card.Description id="onboarding-desc" class="text-muted-foreground text-xs">
          Step {stepIndex + 1} of {flowSteps.length}
        </Card.Description>
      </Card.Header>

      <Card.Content class="space-y-3 text-sm text-card-foreground">
        {#if stepId === 'welcome'}
          <p class="text-xs leading-relaxed">
            Your memory shouldn't live inside one chat vendor or hyperscaler. Eigen Mesh is yours —
            portable across every AI tool you use, not locked to theirs.
          </p>
        {:else if stepId === 'capture'}
          <p class="text-xs leading-relaxed">
            Eigen Mesh captures what's on your mind and keeps it organized and searchable. Nothing
            to file, nothing to tag.
          </p>
          <p class="text-xs leading-relaxed">
            Type it or say it. It files it away and remembers it for you — so next time you ask, it
            already knows what you knew.
          </p>
        {:else if stepId === 'provider'}
          {#if !byokUiEnabled}
            <p class="text-xs leading-relaxed">
              This deployment manages AI provider credentials centrally. The operator of this
              deployment configures them on the server (provider environment variables) — continue
              and everything will work once they do.
            </p>
          {:else if providerSaved}
            <p class="text-xs leading-relaxed text-emerald-700 dark:text-emerald-400">
              Provider connected. You can change it anytime under Settings → LLM.
            </p>
          {:else}
            <p class="text-xs leading-relaxed">
              Eigen Mesh talks to AI models through your own gateway key. Pick a provider and paste
              its credentials — they stay on your instance, encrypted. You can also skip this and
              set it up later under Settings → LLM.
            </p>
            {#if providerError}
              <p class="text-destructive text-xs">{providerError}</p>
            {/if}
            <div class="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={providerChoice === 'openrouter' ? 'default' : 'outline'}
                class="rounded-[4px] text-xs"
                onclick={() => (providerChoice = 'openrouter')}
              >
                OpenRouter
              </Button>
              <Button
                type="button"
                variant={providerChoice === 'eurouter' ? 'default' : 'outline'}
                class="rounded-[4px] text-xs"
                onclick={() => (providerChoice = 'eurouter')}
              >
                EUrouter
              </Button>
            </div>
            <form
              method="post"
              action="?/saveProvider"
              use:enhance={saveProviderEnhance}
              class="flex flex-col gap-2 pt-1"
            >
              <input type="hidden" name="provider" value={providerChoice} />
              <div class="flex flex-col gap-1">
                <label for="provider-base-url" class="text-xs text-muted-foreground">Base URL</label>
                <input
                  id="provider-base-url"
                  name="baseUrl"
                  type="url"
                  required
                  bind:value={providerBaseUrl}
                  placeholder={providerChoice === 'openrouter'
                    ? 'https://openrouter.ai/api/v1'
                    : 'https://api.eurouter.ai/v1'}
                  class="border-input bg-background h-9 rounded-[4px] border px-2 text-sm"
                />
              </div>
              <div class="flex flex-col gap-1">
                <label for="provider-api-key" class="text-xs text-muted-foreground">API key</label>
                <input
                  id="provider-api-key"
                  name="apiKey"
                  type="password"
                  required
                  bind:value={providerApiKey}
                  autocomplete="off"
                  class="border-input bg-background h-9 rounded-[4px] border px-2 text-sm"
                />
              </div>
              {#if providerChoice === 'openrouter'}
                <div class="flex flex-col gap-1">
                  <label for="provider-model-chat" class="text-xs text-muted-foreground">
                    Chat model
                  </label>
                  <input
                    id="provider-model-chat"
                    name="modelChat"
                    required
                    bind:value={providerModelChat}
                    placeholder="openai/gpt-4o-mini"
                    class="border-input bg-background h-9 rounded-[4px] border px-2 text-sm"
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <label for="provider-model-embedding" class="text-xs text-muted-foreground">
                    Embedding model
                  </label>
                  <input
                    id="provider-model-embedding"
                    name="modelEmbedding"
                    required
                    bind:value={providerModelEmbedding}
                    placeholder="openai/text-embedding-3-small"
                    class="border-input bg-background h-9 rounded-[4px] border px-2 text-sm"
                  />
                </div>
              {:else}
                <div class="flex flex-col gap-1">
                  <label for="provider-rule-chat" class="text-xs text-muted-foreground">
                    Chat routing rule ID
                  </label>
                  <input
                    id="provider-rule-chat"
                    name="ruleChat"
                    required
                    bind:value={providerRuleChat}
                    placeholder="Rule UUID from your EUrouter dashboard"
                    class="border-input bg-background h-9 rounded-[4px] border px-2 text-sm"
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <label for="provider-rule-embedding" class="text-xs text-muted-foreground">
                    Embedding routing rule ID
                  </label>
                  <input
                    id="provider-rule-embedding"
                    name="ruleEmbedding"
                    required
                    bind:value={providerRuleEmbedding}
                    placeholder="Rule UUID from your EUrouter dashboard"
                    class="border-input bg-background h-9 rounded-[4px] border px-2 text-sm"
                  />
                </div>
              {/if}
              <Button
                type="submit"
                class="h-11 w-full rounded-[4px] text-sm font-medium"
              >
                Connect provider
              </Button>
            </form>
          {/if}
        {:else}
          <p class="text-xs leading-relaxed">
            Enable notifications so Eigen Mesh can nudge you with a quick question after setup — and
            later for reminders and memory check-ins.
          </p>
          {#if pushDone}
            <p class="text-xs leading-relaxed text-emerald-700 dark:text-emerald-400">
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
        class="flex flex-wrap items-center justify-between gap-2 border-t border-black/10 pt-4 dark:border-white/15"
      >
        <div class="flex min-w-0 flex-1 items-center gap-2">
          {#if stepIndex > 0}
            <Button
              type="button"
              variant="outline"
              class="rounded-[4px] text-xs"
              onclick={() => (stepIndex -= 1)}
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

        {#if stepIndex < lastStepIndex}
          <Button
            type="button"
            class="rounded-[4px] text-xs"
            onclick={() => (stepIndex += 1)}
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
