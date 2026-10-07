<script lang="ts">
  import Database from '@lucide/svelte/icons/database'
  import Inbox from '@lucide/svelte/icons/inbox'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import MessageCircle from '@lucide/svelte/icons/message-circle'
  import Palette from '@lucide/svelte/icons/palette'
  import Network from '@lucide/svelte/icons/waypoints'
  import { goto, invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import ProviderOnboarding from '$lib/components/provider-onboarding.svelte'

  let {
    providerReady = false,
    byokUiEnabled = true,
  }: { providerReady?: boolean; byokUiEnabled?: boolean } = $props()

  type Step = 'welcome' | 'can-do' | 'connect' | 'company' | 'first-move'

  let step = $state<Step>('welcome')
  let completing = $state(false)
  let error = $state<string | null>(null)

  // The founding interview (step 4): the questions that used to leak into the
  // nucleus chat live HERE, in onboarding. Blank is fine — skipping records
  // nothing.
  let toneInput = $state('')
  let companyNameInput = $state('')
  let positioningInput = $state('')
  let submittingFounding = $state(false)
  let foundingApprovalNote = $state(false)

  const stepNumber = $derived(
    step === 'welcome'
      ? 1
      : step === 'can-do'
        ? 2
        : step === 'connect'
          ? 3
          : step === 'company'
            ? 4
            : 5,
  )

  /**
   * Persist "tour done" (completed or skipped — same meaning: never nag again), then
   * refresh page data so the parent swaps the wizard for the chat. Fails loud: a
   * completion that silently failed would either nag forever or never have run.
   */
  async function complete(): Promise<boolean> {
    if (completing) return false
    completing = true
    error = null
    try {
      const res = await fetch('/api/onboarding/welcome', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Saving setup state failed (HTTP ${res.status}).`)
      }
      await invalidateAll()
      return true
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      return false
    } finally {
      completing = false
    }
  }

  async function goTo(dest: '/capture' | '/memory' | '/brand' | '/graph'): Promise<void> {
    const done = await complete()
    if (done) await goto(resolve(dest))
  }

  /**
   * Submits the founding interview and advances. Blank answers skip the call
   * entirely — no journey, no pages, nothing invented. Fails loud inline: the
   * user stays on the step with the exact error.
   */
  async function submitFounding(): Promise<void> {
    if (submittingFounding) return
    const tone = toneInput.trim()
    const companyName = companyNameInput.trim()
    const positioning = positioningInput.trim()
    if (!tone && !companyName && !positioning) {
      step = 'first-move'
      return
    }
    submittingFounding = true
    error = null
    try {
      const res = await fetch('/api/onboarding/founding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tone, companyName, positioning }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Saving your answers failed (HTTP ${res.status}).`)
      }
      const result = (await res.json()) as { skipped?: boolean; approvalPending?: number }
      foundingApprovalNote = !result.skipped && (result.approvalPending ?? 0) > 0
      step = 'first-move'
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      submittingFounding = false
    }
  }

  const capabilities = [
    {
      icon: MessageCircle,
      title: 'Nucleus chat',
      body: 'Ask anything. It answers with your company\u2019s context — and can act for you, with your approval.',
    },
    {
      icon: Inbox,
      title: 'Capture',
      body: 'Drop a thought by text or voice. It gets understood and filed automatically.',
    },
    {
      icon: Database,
      title: 'Memory',
      body: 'Notes, tasks, projects, timeline — everything you captured, searchable.',
    },
    {
      icon: Network,
      title: 'Knowledge graph',
      body: 'People, topics, and projects as a living map of how things connect.',
    },
    {
      icon: Palette,
      title: 'Brand studio',
      body: 'Shape a visual identity for your company from designs you like.',
    },
    {
      icon: KeyRound,
      title: 'API keys',
      body: 'Connect other tools to your company\u2019s data.',
    },
  ]

  const destinations: Array<{ label: string; path: '/capture' | '/memory' | '/brand' | '/graph' }> = [
    { label: 'Capture a thought', path: '/capture' },
    { label: 'Open my memory', path: '/memory' },
    { label: 'Design my brand', path: '/brand' },
    { label: 'Explore the graph', path: '/graph' },
  ]
</script>

<div class="flex min-h-dvh flex-col items-center justify-center px-4" data-testid="welcome-wizard">
  <div class="w-full max-w-md">
    <p class="text-muted-foreground text-center text-[11px] font-medium tracking-[0.25em] uppercase">
      Eigen Enterprise
    </p>
    <p class="text-muted-foreground mt-6 text-center text-xs tracking-wide">
      Step {stepNumber} of 5
    </p>

    {#if step === 'welcome'}
      <h1 class="mt-2 text-center text-xl font-medium tracking-tight text-balance">
        Welcome. This is your company's operating system.
      </h1>
      <p class="text-muted-foreground mt-3 text-center text-sm leading-relaxed">
        Eigen Enterprise is one private AI for your company, running on your own server. It
        remembers everything you share, keeps your work organized, and acts only with your
        approval.
      </p>
      <ul class="mt-6 space-y-3">
        <li class="border-black/15 border-l-2 pl-3">
          <p class="text-sm leading-relaxed">
            <span class="font-medium">Private.</span>
            Your data lives in your database — not on ours.
          </p>
        </li>
        <li class="border-black/15 border-l-2 pl-3">
          <p class="text-sm leading-relaxed">
            <span class="font-medium">It remembers.</span>
            Notes, tasks, projects, people, decisions.
          </p>
        </li>
        <li class="border-black/15 border-l-2 pl-3">
          <p class="text-sm leading-relaxed">
            <span class="font-medium">You are in charge.</span>
            Anything important waits for your approval.
          </p>
        </li>
      </ul>
      <button
        type="button"
        class="mt-8 h-11 w-full bg-black text-sm font-medium text-white hover:bg-black/90 disabled:opacity-50"
        disabled={completing}
        onclick={() => (step = 'can-do')}
      >
        Continue
      </button>
    {:else if step === 'can-do'}
      <h1 class="mt-2 text-center text-xl font-medium tracking-tight text-balance">
        Here is what it can do.
      </h1>
      <ul class="mt-6 space-y-3">
        {#each capabilities as capability (capability.title)}
          <li class="border border-black/15 flex items-start gap-3 p-3">
            <capability.icon class="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
            <div class="min-w-0">
              <p class="text-sm font-medium">{capability.title}</p>
              <p class="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                {capability.body}
              </p>
            </div>
          </li>
        {/each}
      </ul>
      <button
        type="button"
        class="mt-8 h-11 w-full bg-black text-sm font-medium text-white hover:bg-black/90 disabled:opacity-50"
        disabled={completing}
        onclick={() => (step = 'connect')}
      >
        Continue
      </button>
    {:else if step === 'connect' && !providerReady}
      <h1 class="mt-2 text-center text-xl font-medium tracking-tight text-balance">
        One thing first: the AI needs a brain.
      </h1>
      <p class="text-muted-foreground mt-3 text-center text-sm leading-relaxed">
        Connect an AI provider — the engine that thinks for you. Use a subscription you already
        have, or an API key. This is the one step you cannot skip: without it, nothing works.
      </p>
      <div class="mt-6">
        <ProviderOnboarding {byokUiEnabled} />
      </div>
    {:else if step === 'connect'}
      <h1 class="mt-2 text-center text-xl font-medium tracking-tight text-balance">
        Your AI is connected.
      </h1>
      <p class="text-muted-foreground mt-3 text-center text-sm leading-relaxed">
        The brain works. One last step.
      </p>
      <button
        type="button"
        class="mt-8 h-11 w-full bg-black text-sm font-medium text-white hover:bg-black/90 disabled:opacity-50"
        disabled={completing}
        onclick={() => (step = 'company')}
      >
        Continue
      </button>
    {:else if step === 'company'}
      <h1 class="mt-2 text-center text-xl font-medium tracking-tight text-balance">
        Tell me about your company.
      </h1>
      <p class="text-muted-foreground mt-3 text-center text-sm leading-relaxed">
        Three quick answers shape your site and how the assistant writes for you. Blank is fine —
        you can always add this later.
      </p>
      <div class="mt-6 space-y-4">
        <label class="block">
          <span class="text-sm font-medium">Tone of voice — three words</span>
          <input
            bind:value={toneInput}
            type="text"
            placeholder="e.g. warm, direct, technical"
            class="border-black/15 focus:border-black mt-1 h-10 w-full border bg-white px-3 text-sm outline-none disabled:opacity-50"
            disabled={submittingFounding}
          />
        </label>
        <label class="block">
          <span class="text-sm font-medium">Company name</span>
          <input
            bind:value={companyNameInput}
            type="text"
            placeholder="e.g. Kindred Digital Labs"
            class="border-black/15 focus:border-black mt-1 h-10 w-full border bg-white px-3 text-sm outline-none disabled:opacity-50"
            disabled={submittingFounding}
          />
        </label>
        <label class="block">
          <span class="text-sm font-medium">What does your company do? (one sentence)</span>
          <input
            bind:value={positioningInput}
            type="text"
            placeholder="e.g. An AI-native company OS"
            class="border-black/15 focus:border-black mt-1 h-10 w-full border bg-white px-3 text-sm outline-none disabled:opacity-50"
            disabled={submittingFounding}
          />
        </label>
      </div>
      <button
        type="button"
        class="mt-8 h-11 w-full bg-black text-sm font-medium text-white hover:bg-black/90 disabled:opacity-50"
        disabled={submittingFounding}
        onclick={() => void submitFounding()}
      >
        Continue
      </button>
    {:else}
      <h1 class="mt-2 text-center text-xl font-medium tracking-tight text-balance">
        What do you want to do first?
      </h1>
      <p class="text-muted-foreground mt-3 text-center text-sm leading-relaxed">
        Pick anything — you can change your mind later. The chat is always here.
      </p>
      {#if foundingApprovalNote}
        <p
          class="border-black/15 bg-muted/40 mt-4 border border-dashed px-3 py-2 text-center text-xs leading-relaxed"
        >
          Your pages are drafted — publishing waits for your approval in the chat.
        </p>
      {/if}
      <button
        type="button"
        class="mt-8 h-11 w-full bg-black text-sm font-medium text-white hover:bg-black/90 disabled:opacity-50"
        disabled={completing}
        onclick={() => void complete()}
      >
        Start with the chat
      </button>
      <div class="mt-3 grid grid-cols-1 gap-2">
        {#each destinations as destination (destination.path)}
          <button
            type="button"
            class="border-black/15 hover:border-black h-10 border text-sm font-medium disabled:opacity-50"
            disabled={completing}
            onclick={() => void goTo(destination.path)}
          >
            {destination.label}
          </button>
        {/each}
      </div>
    {/if}

    {#if error}
      <p class="text-destructive mt-4 text-center text-sm leading-relaxed" role="alert">
        {error}
      </p>
    {/if}

    {#if step !== 'connect' || providerReady}
      <div class="mt-4 flex justify-center">
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs disabled:opacity-50"
          disabled={completing}
          onclick={() => void complete()}
        >
          {#if completing}
            <LoaderCircle class="size-3 animate-spin" strokeWidth={1.75} />
          {/if}
          Skip setup
        </button>
      </div>
    {/if}
  </div>
</div>
