<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { onMount } from 'svelte'
  import { fade, fly } from 'svelte/transition'
  import { invalidateAll } from '$app/navigation'
  import ProviderOnboarding from '$lib/components/provider-onboarding.svelte'
  import {
    isSoundEnabled,
    playActPulse,
    playBootSwell,
    playConnectChime,
    primeBootSound,
  } from '$lib/sound/boot-sound'

  let {
    providerReady = false,
    byokUiEnabled = true,
    displayName = null,
    oncomplete,
  }: {
    providerReady?: boolean
    byokUiEnabled?: boolean
    displayName?: string | null
    oncomplete?: (detail: { name: string | null }) => void
  } = $props()

  /**
   * The boot sequence (phase-2e): a cinematic first run, not a form wizard.
   * Acts advance by click or a quiet timer; every act carries tangible purpose
   * or it does not exist (see .pi/skills/tangible-purpose-ui/SKILL.md):
   *   boot → hello → name (only if unknown) → identity → mind (only if no
   *   provider) → handoff into the chat (the parent seeds the agent's greeting).
   * "Skip for now" stays a muted corner link — completing and skipping mean the
   * same thing: the tour never nags again.
   */
  type Act = 'boot' | 'hello' | 'name' | 'identity' | 'mind'

  let act = $state<Act>('boot')
  let identityLine = $state(1)
  // The asked name is captured at boot time on purpose: a prop change mid-flow
  // (invalidateAll refetch) must not re-run or mutate the ask.
  // svelte-ignore state_referenced_locally
  let savedName = $state<string | null>(displayName)
  let nameInput = $state('')
  let nameError = $state<string | null>(null)
  let savingName = $state(false)
  let completing = $state(false)
  let error = $state<string | null>(null)
  let reducedMotion = $state(false)

  const motion = $derived(reducedMotion ? 0 : 1)

  let timers: Array<ReturnType<typeof setTimeout>> = []
  function later(fn: () => void, ms: number): void {
    timers.push(setTimeout(fn, ms))
  }

  function advanceTo(next: Act, play = true): void {
    if (act === next) return
    act = next
    if (play && isSoundEnabled()) playActPulse()
  }

  function advanceFromClick(): void {
    if (completing || savingName) return
    if (act === 'boot') advanceTo('hello')
    else if (act === 'hello') enterFromHello()
    else if (act === 'identity' && identityLine === 1) {
      identityLine = 2
      if (isSoundEnabled()) playActPulse()
    } else if (act === 'identity' && identityLine === 2 && !providerReady) {
      advanceTo('mind')
    }
  }

  function enterFromHello(): void {
    if (savedName) advanceTo('identity')
    else advanceTo('name')
  }

  async function submitName(): Promise<void> {
    if (savingName) return
    const name = nameInput.trim()
    nameError = null
    if (!name) {
      // A blank answer is a valid answer: no name, no call, no persistence.
      savedName = null
      advanceTo('identity', false)
      return
    }
    savingName = true
    try {
      const res = await fetch('/api/onboarding/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Saving your name failed (HTTP ${res.status}).`)
      }
      savedName = name
      advanceTo('identity')
    } catch (err) {
      nameError = err instanceof Error ? err.message : String(err)
    } finally {
      savingName = false
    }
  }

  /**
   * Hands off to the chat: tells the parent FIRST (so the agent's greeting is
   * seeded before the swap), then persists "tour done" and refreshes. Fails
   * loud — a completion that silently failed would nag forever or never run.
   */
  let completed = false
  async function complete(): Promise<void> {
    if (completing || completed) return
    completing = true
    error = null
    oncomplete?.({ name: savedName })
    try {
      const res = await fetch('/api/onboarding/welcome', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Saving setup state failed (HTTP ${res.status}).`)
      }
      completed = true
      await invalidateAll()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      completing = false
    }
  }

  /** The mind connected inside the embedded provider wizard ("Enter the workspace").
   *  Explicit event — no prop-watching, no hidden control flow. */
  function onMindConnected(): void {
    if (isSoundEnabled()) playConnectChime()
    void complete()
  }

  function onRootKeydown(e: KeyboardEvent): void {
    if ((e.key === 'Enter' || e.key === ' ') && act !== 'name' && act !== 'mind') {
      advanceFromClick()
    }
  }

  onMount(() => {
    primeBootSound()
    playBootSwell()
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion = media.matches
    const onMediaChange = (e: MediaQueryListEvent) => (reducedMotion = e.matches)
    media.addEventListener('change', onMediaChange)

    // The opening acts also breathe on their own — but a timer never drags a
    // user backwards: every callback is guarded to its own act.
    later(() => {
      if (act === 'boot') advanceTo('hello')
    }, 1600)
    later(() => {
      if (act === 'hello') enterFromHello()
    }, 3800)
    later(() => {
      if (act === 'identity' && identityLine === 1) {
        identityLine = 2
        if (isSoundEnabled()) playActPulse()
      }
    }, 6200)
    later(() => {
      if (act === 'identity' && identityLine === 2 && !providerReady) advanceTo('mind')
    }, 8800)

    return () => {
      for (const t of timers) clearTimeout(t)
      timers = []
      media.removeEventListener('change', onMediaChange)
    }
  })

  const greeting = $derived(savedName ? `Hello, ${savedName}.` : 'Hello.')
</script>

<svelte:window onkeydown={onRootKeydown} />

<div
  class="flex w-full flex-1 flex-col items-center justify-center px-4 py-10 sm:px-6"
  data-testid="welcome-wizard"
>
  <!-- The orb: a point of light that breathes. Present through every act; it
       dissolves when the tour hands off to the chat. -->
  <div class="pointer-events-none relative mb-10 size-24" data-testid="boot-orb" aria-hidden="true">
    <div class="boot-orb-halo absolute inset-0 rounded-full"></div>
    <div class="boot-orb-core absolute inset-6 rounded-full"></div>
  </div>

  <div class="relative w-full max-w-xl" aria-live="polite">
    {#if act === 'boot'}
      <div class="text-center" in:fade={{ duration: 400 * motion }}>
        <button
          type="button"
          class="text-muted-foreground/40 hover:text-muted-foreground cursor-pointer text-sm tracking-wide"
          onclick={advanceFromClick}
          aria-label="Continue"
        >
          ·
        </button>
      </div>
    {:else if act === 'hello'}
      <h1
        class="text-center text-3xl font-light tracking-tight text-balance sm:text-4xl"
        in:fly={{ y: 10 * motion, duration: 700 * motion }}
      >
        <button
          type="button"
          class="cursor-pointer text-inherit"
          onclick={advanceFromClick}
          aria-label="Continue"
        >
          {greeting}
        </button>
      </h1>
    {:else if act === 'name'}
      <div class="mx-auto max-w-md" in:fly={{ y: 10 * motion, duration: 700 * motion }}>
        <h1 class="text-center text-2xl font-light tracking-tight text-balance sm:text-3xl">
          What should I call you?
        </h1>
        <form
          class="mt-8 flex flex-col items-center gap-4"
          onsubmit={(e) => {
            e.preventDefault()
            void submitName()
          }}
        >
          <input
            bind:value={nameInput}
            type="text"
            aria-label="Your name"
            autocomplete="given-name"
            maxlength="80"
            class="focus:border-black h-11 w-full border-0 border-b border-black/25 bg-transparent px-1 text-center text-lg outline-none disabled:opacity-50"
            disabled={savingName}
          />
          <button
            type="submit"
            class="h-10 px-8 text-sm font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-50"
            disabled={savingName}
          >
            {#if savingName}
              <LoaderCircle class="mx-auto size-4 animate-spin" strokeWidth={1.75} />
            {:else}
              Continue
            {/if}
          </button>
        </form>
        {#if nameError}
          <p class="text-destructive mt-4 text-center text-sm leading-relaxed" role="alert">
            {nameError}
          </p>
        {/if}
      </div>
    {:else if act === 'identity'}
      <div class="text-center">
        {#if identityLine === 1}
          <button
            type="button"
            class="cursor-pointer text-inherit"
            onclick={advanceFromClick}
            aria-label="Continue"
          >
            <span
              class="block text-2xl font-light tracking-tight text-balance sm:text-3xl"
              in:fly={{ y: 10 * motion, duration: 700 * motion }}
            >
              This is the operating system for your company.
            </span>
          </button>
        {:else}
          <p
            class="text-base leading-relaxed text-balance text-muted-foreground sm:text-lg"
            in:fly={{ y: 10 * motion, duration: 700 * motion }}
          >
            You talk. It builds — your website, your work — and it remembers everything. Nothing
            happens without your approval.
          </p>
          {#if providerReady}
            <button
              type="button"
              class="mt-8 h-11 bg-black px-10 text-sm font-medium text-white hover:bg-black/90 disabled:opacity-50"
              disabled={completing}
              onclick={() => void complete()}
            >
              {#if completing}
                <LoaderCircle class="mx-auto size-4 animate-spin" strokeWidth={1.75} />
              {:else}
                Begin
              {/if}
            </button>
          {/if}
        {/if}
      </div>
    {:else if act === 'mind'}
      <div
        class="mx-auto w-full max-w-lg"
        in:fly={{ y: 10 * motion, duration: 700 * motion }}
      >
        <h1 class="text-center text-2xl font-light tracking-tight text-balance sm:text-3xl">
          First, it needs a mind to think with.
        </h1>
        <div class="mt-8">
          <ProviderOnboarding {byokUiEnabled} embedded onconnected={onMindConnected} />
        </div>
      </div>
    {/if}
  </div>

  {#if error}
    <p class="text-destructive mt-6 text-center text-sm leading-relaxed" role="alert">
      {error}
    </p>
  {/if}

  <div class="mt-12">
    <button
      type="button"
      class="text-muted-foreground/60 hover:text-muted-foreground inline-flex items-center gap-1.5 text-xs disabled:opacity-50"
      disabled={completing}
      onclick={() => void complete()}
      data-testid="skip-onboarding"
    >
      {#if completing}
        <LoaderCircle class="size-3 animate-spin" strokeWidth={1.75} />
      {/if}
      Skip for now
    </button>
  </div>
</div>

<style>
  .boot-orb-core {
    background: radial-gradient(circle at 42% 38%, #ffffff 0%, #e8e8e8 55%, #b9b9b9 100%);
    box-shadow:
      0 0 18px 4px rgba(0, 0, 0, 0.14),
      0 0 60px 12px rgba(0, 0, 0, 0.06);
    animation: boot-orb-bloom 1.6s cubic-bezier(0.22, 1, 0.36, 1) both,
      boot-orb-breathe 3.6s ease-in-out 1.6s infinite;
  }
  .boot-orb-halo {
    background: radial-gradient(circle, rgba(0, 0, 0, 0.05) 30%, transparent 70%);
    animation: boot-orb-bloom 2.1s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes boot-orb-bloom {
    from {
      opacity: 0;
      transform: scale(0.2);
      filter: blur(6px);
    }
    to {
      opacity: 1;
      transform: scale(1);
      filter: blur(0);
    }
  }
  @keyframes boot-orb-breathe {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.07);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .boot-orb-core,
    .boot-orb-halo {
      animation: none;
    }
  }
</style>
