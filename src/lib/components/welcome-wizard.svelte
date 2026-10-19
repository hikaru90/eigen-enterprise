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
  import { cancelSpeak, speak } from '$lib/speech/tts'

  let {
    providerReady = false,
    needsMail = false,
    byokUiEnabled = true,
    displayName = null,
    oncomplete,
  }: {
    providerReady?: boolean
    /** The owner hasn't set up company email yet (sign-in codes depend on it). */
    needsMail?: boolean
    byokUiEnabled?: boolean
    displayName?: string | null
    oncomplete?: (detail: { name: string | null }) => void
  } = $props()

  /**
   * The boot sequence (phase-2e): a cinematic first run, not a form wizard.
   * Every act carries tangible purpose or it does not exist
   * (see .pi/skills/tangible-purpose-ui/SKILL.md):
   *   boot → hello → name (only if unknown) → lines (one per step) →
   *   mail (owner only, until login-code email works) → mind (only if no
   *   provider) → handoff into the chat, where the AI takes over.
   * Every step has a visible Continue and Back; "Skip for now" stays a muted
   * corner link — completing and skipping mean the same thing.
   */
  type Act = 'boot' | 'hello' | 'name' | 'lines' | 'mail' | 'mind'

  type Line = { text: string; quiet?: boolean }
  const BASE_LINES: Line[] = [
    { text: 'This is the operating system for your company.' },
    {
      text: 'You talk. It builds — your website, your work — and it remembers everything. Nothing happens without your approval.',
      quiet: true,
    },
    {
      text: 'This is a modular system. A company is made of different parts that have to work together.',
    },
    {
      text: 'I am the fabric that holds everything in place and makes all the parts work together.',
    },
    { text: "Let's start by building out your company." },
  ]
  const LOGIN_LINE: Line = {
    text: "First, we need a way to log you in securely — so let's set up email for your login codes.",
  }

  const MIND_HEADING = 'Now, it needs a mind to think with.'
  const MAIL_HEADING = 'Email for your login codes'

  /** Common Amazon SES regions, in plain words. */
  const SES_REGIONS: Array<{ id: string; label: string }> = [
    { id: 'eu-central-1', label: 'Europe — Frankfurt (eu-central-1)' },
    { id: 'eu-west-1', label: 'Europe — Ireland (eu-west-1)' },
    { id: 'eu-west-2', label: 'Europe — London (eu-west-2)' },
    { id: 'eu-west-3', label: 'Europe — Paris (eu-west-3)' },
    { id: 'eu-north-1', label: 'Europe — Stockholm (eu-north-1)' },
    { id: 'us-east-1', label: 'US East — N. Virginia (us-east-1)' },
    { id: 'us-east-2', label: 'US East — Ohio (us-east-2)' },
    { id: 'us-west-2', label: 'US West — Oregon (us-west-2)' },
    { id: 'ca-central-1', label: 'Canada (ca-central-1)' },
    { id: 'ap-south-1', label: 'Asia Pacific — Mumbai (ap-south-1)' },
    { id: 'ap-southeast-1', label: 'Asia Pacific — Singapore (ap-southeast-1)' },
    { id: 'ap-southeast-2', label: 'Asia Pacific — Sydney (ap-southeast-2)' },
    { id: 'ap-northeast-1', label: 'Asia Pacific — Tokyo (ap-northeast-1)' },
    { id: 'sa-east-1', label: 'South America — São Paulo (sa-east-1)' },
  ]

  // Captured at boot on purpose: an invalidateAll refetch mid-flow (e.g. after
  // email is saved) must not reshuffle the steps under the user.
  // svelte-ignore state_referenced_locally
  const askMail = needsMail
  const lines: Line[] = askMail ? [...BASE_LINES, LOGIN_LINE] : BASE_LINES

  let act = $state<Act>('boot')
  let lineIndex = $state(0)
  // The asked name is captured at boot time on purpose: a prop change mid-flow
  // (invalidateAll refetch) must not re-run or mutate the ask.
  // svelte-ignore state_referenced_locally
  let savedName = $state<string | null>(displayName)
  let nameInput = $state('')
  let nameError = $state<string | null>(null)
  let savingName = $state(false)
  let completing = $state(false)
  let mailRegion = $state('eu-central-1')
  let mailAccessKeyId = $state('')
  let mailSecretAccessKey = $state('')
  let mailFrom = $state('')
  let mailSaving = $state(false)
  let mailError = $state<string | null>(null)
  /** Amazon still has to confirm the send-from address (409 verify_sender). */
  let mailVerifyAddress = $state<string | null>(null)
  let mailSentTo = $state<string | null>(null)
  let error = $state<string | null>(null)
  let reducedMotion = $state(false)

  const motion = $derived(reducedMotion ? 0 : 1)
  const isLastLine = $derived(lineIndex === lines.length - 1)
  /** The last line ends the tour itself when nothing is left to set up. */
  const lastLineBegins = $derived(!askMail && providerReady)

  let timers: Array<ReturnType<typeof setTimeout>> = []
  function later(fn: () => void, ms: number): void {
    timers.push(setTimeout(fn, ms))
  }

  /** Acts visited, for Back. Boot and hello are the opening, not stops to return to. */
  let history = $state<Act[]>([])

  function advanceTo(next: Act, play = true): void {
    if (act === next) return
    if (act !== 'boot' && act !== 'hello') history = [...history, act]
    act = next
    if (next === 'lines') lineIndex = 0
    // The opening breathes on its own; the timer starts when the act appears,
    // so it can never fire early.
    if (next === 'hello') later(() => act === 'hello' && enterFromHello(), 2200)
    if (play && isSoundEnabled()) playActPulse()
    // The voice speaks the act as it appears (the Her layer); sound and voice
    // are independent toggles.
    if (next === 'hello') speak(greeting)
    else if (next === 'name') speak('What should I call you?')
    else if (next === 'lines') speak(lines[0].text)
    else if (next === 'mail') speak(MAIL_HEADING)
    else if (next === 'mind') speak(MIND_HEADING)
  }

  /** After the lines (and after email): the mind if missing, else the handoff. */
  function afterMail(): void {
    if (providerReady) void complete()
    else advanceTo('mind')
  }

  function nextLine(): void {
    if (completing) return
    if (!isLastLine) {
      lineIndex += 1
      if (isSoundEnabled()) playActPulse()
      speak(lines[lineIndex].text)
      return
    }
    if (askMail) advanceTo('mail')
    else afterMail()
  }

  function advanceFromClick(): void {
    if (completing || savingName) return
    if (act === 'boot') advanceTo('hello')
    else if (act === 'hello') enterFromHello()
    else if (act === 'lines') nextLine()
  }

  function goBack(): void {
    if (act === 'lines' && lineIndex > 0) {
      lineIndex -= 1
      return
    }
    const prev = history.at(-1)
    if (!prev) return
    history = history.slice(0, -1)
    act = prev
    if (prev === 'lines') lineIndex = lines.length - 1
  }

  function enterFromHello(): void {
    if (savedName) advanceTo('lines')
    else advanceTo('name')
  }

  async function submitName(): Promise<void> {
    if (savingName) return
    const name = nameInput.trim()
    nameError = null
    if (!name) {
      // A blank answer is a valid answer: no name, no call, no persistence.
      savedName = null
      advanceTo('lines', false)
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
      advanceTo('lines')
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

  /** The mind connected inside the embedded provider wizard. Explicit event. */
  function onMindConnected(): void {
    if (isSoundEnabled()) playConnectChime()
    void complete()
  }

  type MailResponse = {
    ok?: boolean
    testSentTo?: string
    error?: string
    needs?: string
    emailFrom?: string
  }

  /** Save Amazon SES credentials — the server sends a real test email first. */
  async function submitMail(): Promise<void> {
    if (mailSaving) return
    mailSaving = true
    mailError = null
    mailVerifyAddress = null
    try {
      const res = await fetch('/api/onboarding/mail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          region: mailRegion,
          accessKeyId: mailAccessKeyId.trim(),
          secretAccessKey: mailSecretAccessKey,
          emailFrom: mailFrom.trim(),
        }),
      })
      const body = (await res.json().catch(() => null)) as MailResponse | null
      if (res.status === 409 && body?.needs === 'verify_sender') {
        if (!body.emailFrom)
          throw new Error('The server asked for sender verification without naming the address.')
        mailVerifyAddress = body.emailFrom
        return
      }
      if (!res.ok) throw new Error(body?.error ?? `Setting up email failed (HTTP ${res.status}).`)
      if (!body?.testSentTo) throw new Error('The server did not say where the test email went.')
      mailSentTo = body.testSentTo
      if (isSoundEnabled()) playConnectChime()
    } catch (err) {
      mailError = err instanceof Error ? err.message : String(err)
    } finally {
      mailSaving = false
    }
  }

  function onRootKeydown(e: KeyboardEvent): void {
    if (
      (e.key === 'Enter' || e.key === ' ') &&
      (act === 'boot' || act === 'hello' || act === 'lines')
    ) {
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

    // The opening breathes on its own — every callback is guarded to its own act.
    later(() => {
      if (act === 'boot') advanceTo('hello')
    }, 1600)

    return () => {
      for (const t of timers) clearTimeout(t)
      timers = []
      media.removeEventListener('change', onMediaChange)
      cancelSpeak()
    }
  })

  const greeting = $derived(savedName ? `Hello, ${savedName}.` : 'Hello.')
  const inputClass =
    'focus:border-black mt-1 h-10 w-full border-0 border-b border-black/25 bg-transparent px-1 text-base text-foreground outline-none disabled:opacity-50'
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
    {:else if act === 'lines'}
      <div class="text-center">
        {#key lineIndex}
          <button type="button" class="cursor-pointer text-inherit" onclick={advanceFromClick}>
            <span
              class={lines[lineIndex].quiet
                ? 'block text-base leading-relaxed text-balance text-muted-foreground sm:text-lg'
                : 'block text-2xl font-light tracking-tight text-balance sm:text-3xl'}
              in:fly={{ y: 10 * motion, duration: 700 * motion }}
            >
              {lines[lineIndex].text}
            </span>
          </button>
        {/key}
        <div>
          <button
            type="button"
            class={isLastLine
              ? 'mt-8 h-11 bg-black px-10 text-sm font-medium text-white hover:bg-black/90 disabled:opacity-50'
              : 'mt-8 h-11 px-10 text-sm font-medium text-foreground underline-offset-4 hover:underline'}
            disabled={completing}
            onclick={nextLine}
            data-testid="onboarding-continue"
          >
            {#if completing}
              <LoaderCircle class="mx-auto size-4 animate-spin" strokeWidth={1.75} />
            {:else}
              {isLastLine && lastLineBegins ? 'Begin' : 'Continue'}
            {/if}
          </button>
        </div>
      </div>
    {:else if act === 'mail'}
      <div
        class="mx-auto w-full max-w-md"
        in:fly={{ y: 10 * motion, duration: 700 * motion }}
        data-testid="onboarding-mail"
      >
        <h1 class="text-center text-2xl font-light tracking-tight text-balance sm:text-3xl">
          {MAIL_HEADING}
        </h1>
        {#if mailSentTo}
          <p class="mt-8 text-center text-base text-balance" role="status">
            Test email sent to {mailSentTo}
          </p>
          <div class="text-center">
            <button
              type="button"
              class="mt-8 h-11 bg-black px-10 text-sm font-medium text-white hover:bg-black/90 disabled:opacity-50"
              disabled={completing}
              onclick={afterMail}
              data-testid="onboarding-continue"
            >
              {#if completing}
                <LoaderCircle class="mx-auto size-4 animate-spin" strokeWidth={1.75} />
              {:else}
                Continue
              {/if}
            </button>
          </div>
        {:else}
          <p class="text-muted-foreground mt-3 text-center text-sm text-balance">
            Your login codes are sent through Amazon SES — Amazon's email service. It takes a few
            minutes:
          </p>
          <ol class="text-muted-foreground mt-4 list-decimal space-y-1 pl-5 text-sm">
            <li>Create an Amazon Web Services account if you don't have one.</li>
            <li>
              Open the
              <a
                href="https://console.aws.amazon.com/ses/"
                target="_blank"
                rel="noopener noreferrer"
                class="text-foreground underline underline-offset-4">Amazon SES console</a
              >.
            </li>
            <li>
              In IAM (Amazon's user settings), create an access key for a user that is allowed to
              send email.
            </li>
            <li>Pick the region your SES account is in, and paste the key below.</li>
          </ol>
          <form
            class="mt-8 flex flex-col gap-5"
            onsubmit={(e) => {
              e.preventDefault()
              void submitMail()
            }}
          >
            <label class="text-xs text-muted-foreground">
              Region
              <select bind:value={mailRegion} class={inputClass} disabled={mailSaving}>
                {#each SES_REGIONS as region (region.id)}
                  <option value={region.id}>{region.label}</option>
                {/each}
              </select>
            </label>
            <label class="text-xs text-muted-foreground">
              Access key ID
              <input
                bind:value={mailAccessKeyId}
                type="text"
                required
                autocomplete="off"
                class={inputClass}
                disabled={mailSaving}
              />
            </label>
            <label class="text-xs text-muted-foreground">
              Secret access key
              <input
                bind:value={mailSecretAccessKey}
                type="password"
                required
                autocomplete="off"
                class={inputClass}
                disabled={mailSaving}
              />
            </label>
            <label class="text-xs text-muted-foreground">
              Send-from address
              <input
                bind:value={mailFrom}
                type="email"
                required
                placeholder="hello@yourcompany.com"
                class={inputClass}
                disabled={mailSaving}
              />
            </label>
            {#if mailVerifyAddress}
              <p class="text-center text-sm leading-relaxed text-balance" role="status">
                Amazon sent a verification email to {mailVerifyAddress}. Click the link in it, then
                press Try again.
              </p>
            {/if}
            <button
              type="submit"
              class="mt-2 h-11 bg-black px-10 text-sm font-medium text-white hover:bg-black/90 disabled:opacity-50"
              disabled={mailSaving}
            >
              {#if mailSaving}
                <LoaderCircle class="mx-auto size-4 animate-spin" strokeWidth={1.75} />
              {:else if mailVerifyAddress}
                Try again
              {:else}
                Send me a test email
              {/if}
            </button>
          </form>
          {#if mailError}
            <p class="text-destructive mt-4 text-center text-sm leading-relaxed" role="alert">
              {mailError}
            </p>
          {/if}
        {/if}
      </div>
    {:else if act === 'mind'}
      <div class="mx-auto w-full max-w-lg" in:fly={{ y: 10 * motion, duration: 700 * motion }}>
        <h1 class="text-center text-2xl font-light tracking-tight text-balance sm:text-3xl">
          {MIND_HEADING}
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

  <div class="mt-12 flex items-center gap-6">
    {#if act !== 'boot' && act !== 'hello' && (history.length > 0 || (act === 'lines' && lineIndex > 0))}
      <button
        type="button"
        class="text-muted-foreground/60 hover:text-muted-foreground text-xs"
        onclick={goBack}
        data-testid="onboarding-back"
      >
        ← Back
      </button>
    {/if}
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
    animation:
      boot-orb-bloom 1.6s cubic-bezier(0.22, 1, 0.36, 1) both,
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
