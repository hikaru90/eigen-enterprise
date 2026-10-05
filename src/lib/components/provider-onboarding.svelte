<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { onMount } from 'svelte'
  import { invalidateAll } from '$app/navigation'

  let { byokUiEnabled = true }: { byokUiEnabled?: boolean } = $props()

  type CatalogModel = { id: string; name: string }
  type CatalogProvider = {
    id: string
    name: string
    baseUrl: string
    envVar: string | null
    docUrl: string | null
    chatModels: CatalogModel[]
    embeddingModels: CatalogModel[]
  }

  type Method = 'subscription' | 'api-key'
  type Step = 'method' | 'provider' | 'models' | 'credentials' | 'connected'
  type Phase = 'idle' | 'connecting'

  let step = $state<Step>('method')
  let method = $state<Method>('api-key')
  let phase = $state<Phase>('idle')
  let error = $state<string | null>(null)

  // Catalog (API-key path)
  let catalog = $state<CatalogProvider[]>([])
  let catalogError = $state<string | null>(null)
  let catalogLoading = $state(false)
  let providerSearch = $state('')
  let selectedProvider = $state<CatalogProvider | null>(null)
  let baseUrl = $state('')
  let apiKey = $state('')
  let ruleChat = $state('')
  let ruleEmbedding = $state('')
  let modelChat = $state('')
  let modelEmbedding = $state('')

  // Subscription sign-in state (model step + device/paste cards)
  type SubscriptionFlow = 'anthropic' | 'openai_codex' | 'github_copilot' | 'openrouter-signin'
  let subscriptionFlow = $state<SubscriptionFlow | null>(null)
  let subChatModels = $state<CatalogModel[]>([])
  let subEmbeddingModels = $state<CatalogModel[]>([])
  let subModelsLoading = $state(false)
  let subModelsError = $state<string | null>(null)
  let chosenChatModel = $state('')
  let chosenEmbeddingModel = $state('')
  let deviceCode = $state<string | null>(null) // copilot device_code
  let deviceFlow = $state<'github_copilot' | 'openai_codex' | null>(null)
  let deviceAuthId = $state<string | null>(null) // openai device_auth_id
  let userCode = $state<string | null>(null)
  let verificationUri = $state<string | null>(null)
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pastedCode = $state('') // anthropic paste-code
  let pasteBusy = $state(false)

  let connectedSummary = $state<string | null>(null)

  const connecting = $derived(phase === 'connecting')
  const selectedEmbeddingsSupported = $derived(
    selectedProvider ? selectedProvider.embeddingModels.length > 0 : false,
  )
  const filteredCatalog = $derived.by(() => {
    const query = providerSearch.trim().toLowerCase()
    if (!query) return catalog
    return catalog.filter(
      (p) => p.name.toLowerCase().includes(query) || p.id.toLowerCase().includes(query),
    )
  })
  onMount(() => {
    return () => {
      if (pollTimer) clearInterval(pollTimer)
    }
  })

  async function loadCatalog(): Promise<void> {
    catalogLoading = true
    catalogError = null
    try {
      const res = await fetch('/api/onboarding/catalog')
      const body = (await res.json().catch(() => null)) as
        | { providers?: CatalogProvider[]; error?: string }
        | null
      if (!res.ok || !body?.providers) {
        throw new Error(body?.error ?? `Provider catalog failed (${res.status})`)
      }
      catalog = body.providers
    } catch (e) {
      catalogError = e instanceof Error ? e.message : String(e)
    } finally {
      catalogLoading = false
    }
  }

  function chooseMethod(next: Method): void {
    error = null
    method = next
    step = 'provider'
    if (next === 'api-key' && catalog.length === 0 && !catalogError) {
      void loadCatalog()
    }
  }

  function chooseApiKeyProvider(entry: CatalogProvider): void {
    error = null
    selectedProvider = entry
    baseUrl = entry.baseUrl || ''
    ruleChat = ''
    ruleEmbedding = ''
    // No implicit model defaults — the user picks explicitly.
    modelChat = ''
    modelEmbedding = ''
    step = 'credentials'
  }

  function chooseSubscription(flow: SubscriptionFlow): void {
    error = null
    selectedProvider = null
    subscriptionFlow = flow
    chosenChatModel = ''
    chosenEmbeddingModel = ''
    deviceCode = null
    deviceAuthId = null
    userCode = null
    verificationUri = null
    pastedCode = ''
    step = 'models'
    void loadSubscriptionModels(flow)
  }

  /** Flow id → models.dev catalog id. */
  const CATALOG_ID: Record<SubscriptionFlow, string> = {
    anthropic: 'anthropic',
    openai_codex: 'openai-codex',
    github_copilot: 'github-copilot',
    'openrouter-signin': 'openrouter',
  }

  async function loadSubscriptionModels(flow: SubscriptionFlow): Promise<void> {
    const catalogId = CATALOG_ID[flow]
    subModelsLoading = true
    subModelsError = null
    subChatModels = []
    subEmbeddingModels = []
    try {
      const res = await fetch(`/api/onboarding/catalog/models?provider=${catalogId}`)
      const body = (await res.json().catch(() => null)) as
        | { chatModels?: CatalogModel[]; embeddingModels?: CatalogModel[]; error?: string }
        | null
      if (!res.ok || !body?.chatModels) {
        throw new Error(body?.error ?? `Model list failed (${res.status})`)
      }
      subChatModels = body.chatModels
      subEmbeddingModels = body.embeddingModels ?? []
    } catch (e) {
      subModelsError = e instanceof Error ? e.message : String(e)
    } finally {
      subModelsLoading = false
    }
  }

  function confirmModels(): void {
    if (!chosenChatModel.trim()) {
      error = 'Pick a chat model to continue.'
      return
    }
    if (subscriptionFlow === 'openrouter-signin') {
      // OpenRouter completes via its redirect callback — the choices travel in the
      // PKCE cookie (authorize → callback).
      error = null
      phase = 'connecting'
      void (async () => {
        try {
          const res = await fetch('/api/onboarding/openrouter/authorize', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              modelChat: chosenChatModel.trim(),
              modelEmbedding: chosenEmbeddingModel.trim(),
            }),
          })
          const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null
          if (!res.ok || !body?.url) {
            throw new Error(body?.error ?? `Sign-in could not start (${res.status})`)
          }
          window.location.href = body.url
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
          phase = 'idle'
        }
      })()
      return
    }
    error = null
    step = 'credentials'
    if (subscriptionFlow === 'anthropic') {
      deviceFlow = null
      void startAnthropicAuthorize()
    } else if (subscriptionFlow === 'openai_codex') {
      deviceFlow = 'openai_codex'
      void startOpenAiDevice()
    } else if (subscriptionFlow === 'github_copilot') {
      deviceFlow = 'github_copilot'
      void startCopilot()
    }
  }

  async function startCopilot(): Promise<void> {
    phase = 'connecting'
    try {
      const res = await fetch('/api/onboarding/copilot/start', { method: 'POST' })
      const body = (await res.json().catch(() => null)) as
        | {
            deviceCode?: string
            userCode?: string
            verificationUri?: string
            intervalSeconds?: number
            error?: string
          }
        | null
      if (!res.ok || !body?.deviceCode || !body.userCode || !body.verificationUri) {
        throw new Error(body?.error ?? `Sign-in could not start (${res.status})`)
      }
      deviceCode = body.deviceCode
      userCode = body.userCode
      verificationUri = body.verificationUri
      const intervalMs = Math.max((body.intervalSeconds ?? 5) * 1000, 1000)
      pollTimer = setInterval(() => void pollCopilot(), intervalMs)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      phase = 'idle'
    }
  }

  async function pollCopilot(): Promise<void> {
    if (!deviceCode || pollTimer === null) return
    try {
      const res = await fetch('/api/onboarding/copilot/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode, modelChat: chosenChatModel.trim() }),
      })
      const body = (await res.json().catch(() => null)) as
        | { status?: string; error?: string; models?: string[]; baseUrl?: string }
        | null
      if (body?.status === 'pending') return
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
      if (body?.status === 'connected') {
        connectedSummary = `GitHub Copilot · ${chosenChatModel.trim()}`
        phase = 'idle'
        step = 'connected'
        return
      }
      error = body?.error ?? 'Copilot sign-in failed.'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function startOpenAiDevice(): Promise<void> {
    phase = 'connecting'
    try {
      const res = await fetch('/api/onboarding/oauth/openai/start', { method: 'POST' })
      const body = (await res.json().catch(() => null)) as
        | {
            deviceAuthId?: string
            userCode?: string
            verificationUri?: string
            intervalSeconds?: number
            error?: string
          }
        | null
      if (!res.ok || !body?.deviceAuthId || !body.userCode || !body.verificationUri) {
        throw new Error(body?.error ?? `Sign-in could not start (${res.status})`)
      }
      deviceAuthId = body.deviceAuthId
      userCode = body.userCode
      verificationUri = body.verificationUri
      const intervalMs = Math.max((body.intervalSeconds ?? 5) * 1000, 1000)
      pollTimer = setInterval(() => void pollOpenAi(), intervalMs)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      phase = 'idle'
    }
  }

  async function pollOpenAi(): Promise<void> {
    if (!deviceAuthId || !userCode || pollTimer === null) return
    try {
      const res = await fetch('/api/onboarding/oauth/openai/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceAuthId, userCode, modelChat: chosenChatModel.trim() }),
      })
      const body = (await res.json().catch(() => null)) as { status?: string; error?: string } | null
      if (body?.status === 'pending') return
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
      if (body?.status === 'connected') {
        connectedSummary = `ChatGPT subscription · ${chosenChatModel.trim()}`
        phase = 'idle'
        step = 'connected'
        return
      }
      error = body?.error ?? 'ChatGPT sign-in failed.'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function startAnthropicAuthorize(): Promise<void> {
    phase = 'connecting'
    try {
      const res = await fetch('/api/onboarding/oauth/anthropic/authorize', { method: 'POST' })
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null
      if (!res.ok || !body?.url) {
        throw new Error(body?.error ?? `Sign-in could not start (${res.status})`)
      }
      window.open(body.url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      phase = 'idle'
    }
  }

  async function connectAnthropicPaste(): Promise<void> {
    if (pasteBusy) return
    pasteBusy = true
    error = null
    try {
      const res = await fetch('/api/onboarding/oauth/anthropic/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: pastedCode.trim(), modelChat: chosenChatModel.trim() }),
      })
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? `Sign-in failed (${res.status})`)
      }
      connectedSummary = `Claude Pro/Max · ${chosenChatModel.trim()}`
      phase = 'idle'
      step = 'connected'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      pasteBusy = false
    }
  }

  async function callOnboardingApi(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as { error?: string } | null
    if (!res.ok) {
      throw new Error(json?.error ?? `Request failed (${res.status})`)
    }
    return json
  }

  async function connect(): Promise<void> {
    if (connecting || step === 'connected' || !selectedProvider) return
    error = null
    phase = 'connecting'
    const input = {
      provider: selectedProvider.id,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      ruleChat: ruleChat.trim(),
      ruleEmbedding: ruleEmbedding.trim(),
      modelChat: modelChat.trim(),
      modelEmbedding: modelEmbedding.trim(),
    }
    try {
      // Guided means proven: one real 1-token gateway call before anything is saved.
      const test = (await callOnboardingApi('/api/onboarding/test-provider', input)) as {
        ok: boolean
        model?: string
        latencyMs?: number
        error?: string
      }
      if (!test.ok) {
        error = test.error ?? 'The provider did not respond.'
        phase = 'idle'
        return
      }
      await callOnboardingApi('/api/onboarding/provider', input)
      connectedSummary = `${selectedProvider.name} · ${test.model} · ${test.latencyMs}ms`
      phase = 'idle'
      step = 'connected'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      phase = 'idle'
    }
  }

  function back(): void {
    error = null
    if (step === 'models') step = 'provider'
    else if (step === 'credentials') {
      if (subscriptionFlow) step = 'models'
      else step = 'provider'
    } else if (step === 'provider') step = 'method'
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }
</script>

<div class="flex min-h-dvh flex-col items-center justify-center px-4">
  <div class="w-full max-w-md">
    <p class="text-muted-foreground text-center text-[11px] font-medium tracking-[0.25em] uppercase">
      Eigen Enterprise
    </p>

    <h1 class="mt-8 text-center text-xl font-medium tracking-tight text-balance">
      Connect your AI provider.
    </h1>
    <p class="text-muted-foreground mt-2 text-center text-sm leading-relaxed">
      Your agent runs on credentials you own. Sign in with a subscription you already have, or
      bring an API key.
    </p>

    {#if !byokUiEnabled}
      <div class="mt-8 border border-black/15 p-4">
        <p class="text-sm leading-relaxed">
          This deployment manages AI provider credentials centrally. The operator of this
          deployment configures them on the server (provider environment variables) — once they
          do, the workspace opens by itself.
        </p>
      </div>
    {:else if step === 'connected'}
      <div class="mt-8 border-2 border-black p-4">
        <p class="text-sm font-medium">Connected.</p>
        {#if connectedSummary}
          <p class="text-muted-foreground mt-1 text-xs">{connectedSummary}</p>
        {/if}
        <button
          type="button"
          class="mt-4 h-11 w-full bg-black text-sm font-medium text-white hover:bg-black/90"
          onclick={() => void invalidateAll()}
        >
          Enter the workspace →
        </button>
      </div>
    {:else if step === 'method'}
      <div class="mt-8 grid grid-cols-1 gap-3">
        <button
          type="button"
          class="border-2 px-4 py-4 text-left transition-colors hover:border-black"
          onclick={() => chooseMethod('subscription')}
        >
          <span class="block text-sm font-medium">Use a subscription I have</span>
          <span class="text-muted-foreground mt-0.5 block text-xs">
            Sign in with your existing account (Claude, ChatGPT, Copilot, OpenRouter)
          </span>
        </button>
        <button
          type="button"
          class="border-2 px-4 py-4 text-left transition-colors hover:border-black"
          onclick={() => chooseMethod('api-key')}
        >
          <span class="block text-sm font-medium">Use an API key</span>
          <span class="text-muted-foreground mt-0.5 block text-xs">
            EUrouter, OpenRouter, Groq, Mistral, OpenAI and dozens more
          </span>
        </button>
      </div>
    {:else if step === 'provider'}
      {#if method === 'subscription'}
        <div class="mt-8 space-y-3">
          <button
            type="button"
            class="border-2 px-4 py-4 text-left transition-colors hover:border-black"
            onclick={() => chooseSubscription('anthropic')}
          >
            <span class="block text-sm font-medium">Claude Pro/Max</span>
            <span class="text-muted-foreground mt-0.5 block text-xs">
              Sign in with your Claude account — no API key. Chat only.
            </span>
          </button>
          <button
            type="button"
            class="border-2 px-4 py-4 text-left transition-colors hover:border-black"
            onclick={() => chooseSubscription('openai_codex')}
          >
            <span class="block text-sm font-medium">ChatGPT Plus/Pro</span>
            <span class="text-muted-foreground mt-0.5 block text-xs">
              Sign in with your ChatGPT account — no API key. Chat only.
            </span>
          </button>
          <button
            type="button"
            class="border-2 px-4 py-4 text-left transition-colors hover:border-black"
            onclick={() => chooseSubscription('github_copilot')}
          >
            <span class="block text-sm font-medium">GitHub Copilot</span>
            <span class="text-muted-foreground mt-0.5 block text-xs">
              Sign in with your GitHub account — no API key. Chat only.
            </span>
          </button>
          <button
            type="button"
            class="border-2 px-4 py-4 text-left transition-colors hover:border-black"
            onclick={() => chooseSubscription('openrouter-signin')}
          >
            <span class="block text-sm font-medium">Sign in with OpenRouter</span>
            <span class="text-muted-foreground mt-0.5 block text-xs">
              Create a key through your OpenRouter account automatically.
            </span>
          </button>
          {#if error}
            <p class="text-destructive text-xs leading-relaxed">{error}</p>
          {/if}
          {#if connecting}
            <p class="text-muted-foreground flex items-center gap-2 text-xs">
              <LoaderCircle class="size-3.5 animate-spin" strokeWidth={1.75} />
              Redirecting to sign-in…
            </p>
          {/if}
        </div>
      {:else if catalogLoading}
        <p class="text-muted-foreground mt-8 flex items-center gap-2 text-xs">
          <LoaderCircle class="size-3.5 animate-spin" strokeWidth={1.75} />
          Loading providers…
        </p>
      {:else if catalogError}
        <div class="mt-8">
          <p class="text-destructive text-xs leading-relaxed">{catalogError}</p>
          <button
            type="button"
            class="mt-3 h-9 border-2 border-black px-4 text-xs font-medium"
            onclick={() => void loadCatalog()}
          >
            Retry
          </button>
        </div>
      {:else}
        <div class="mt-6">
          <input
            type="search"
            placeholder="Search providers…"
            bind:value={providerSearch}
            class="focus:border-black h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
          />
          <div class="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
            {#each filteredCatalog as entry (entry.id)}
              <button
                type="button"
                class="w-full border border-black/15 px-4 py-3 text-left transition-colors hover:border-black"
                onclick={() => chooseApiKeyProvider(entry)}
              >
                <span class="block text-sm font-medium">{entry.name}</span>
                <span class="text-muted-foreground mt-0.5 block text-xs">
                  {entry.chatModels.length} chat models{entry.embeddingModels.length
                    ? ` · ${entry.embeddingModels.length} embedding models`
                    : ''}
                </span>
              </button>
            {:else}
              <p class="text-muted-foreground text-xs">No provider matches that search.</p>
            {/each}
          </div>
          {#if error}
            <p class="text-destructive mt-3 text-xs leading-relaxed">{error}</p>
          {/if}
        </div>
      {/if}
    {:else if step === 'models'}
      <div class="mt-8 space-y-3">
        <p class="text-muted-foreground text-xs leading-relaxed">
          Pick the model your agent will use. This is explicit on purpose — no hidden default.
        </p>
        {#if subModelsLoading}
          <p class="text-muted-foreground flex items-center gap-2 text-xs">
            <LoaderCircle class="size-3.5 animate-spin" strokeWidth={1.75} />
            Loading models…
          </p>
        {:else if subModelsError}
          <p class="text-destructive text-xs leading-relaxed">{subModelsError}</p>
          <button
            type="button"
            class="h-9 border-2 border-black px-4 text-xs font-medium"
            onclick={() => void loadSubscriptionModels(subscriptionFlow!)}
          >
            Retry
          </button>
        {:else}
          <div>
            <label
              for="sub-chat-model"
              class="text-muted-foreground block text-[10px] font-medium tracking-wider uppercase"
            >
              Chat model
            </label>
            <input
              id="sub-chat-model"
              required
              list="sub-chat-model-options"
              bind:value={chosenChatModel}
              placeholder="Select or type a model id"
              class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
            />
            <datalist id="sub-chat-model-options">
              {#each subChatModels as model (model.id)}
                <option value={model.id}>{model.name}</option>
              {/each}
            </datalist>
          </div>
          {#if subEmbeddingModels.length > 0}
            <div>
              <label
                for="sub-embedding-model"
                class="text-muted-foreground block text-[10px] font-medium tracking-wider uppercase"
              >
                Embedding model
              </label>
              <input
                id="sub-embedding-model"
                list="sub-embedding-model-options"
                bind:value={chosenEmbeddingModel}
                placeholder="Select or type a model id"
                class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
              />
              <datalist id="sub-embedding-model-options">
                {#each subEmbeddingModels as model (model.id)}
                  <option value={model.id}>{model.name}</option>
                {/each}
              </datalist>
              <p class="text-muted-foreground mt-1 text-xs">
                Needed for memory features.
              </p>
            </div>
          {:else}
            <p class="text-muted-foreground text-xs leading-relaxed">
              This provider has no embedding models. Memory features need one — add an
              embedding-capable provider later under Settings → LLM.
            </p>
          {/if}
          <button
            type="button"
            disabled={!chosenChatModel.trim()}
            onclick={confirmModels}
            class="h-11 w-full bg-black text-sm font-medium text-white hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-70"
          >
            Continue
          </button>
        {/if}
      </div>
    {:else if step === 'credentials' && selectedProvider}
      <div class="mt-8 space-y-3">
        <p class="text-muted-foreground text-xs">
          {selectedProvider.name}
          · {chosenChatModel.trim() || 'no model selected'}
          {#if selectedProvider.envVar}
            · env: {selectedProvider.envVar}
          {/if}
        </p>
        <div>
          <label
            for="provider-base-url"
            class="text-muted-foreground block text-[10px] font-medium tracking-wider uppercase"
          >
            Base URL
          </label>
          <input
            id="provider-base-url"
            type="url"
            required
            bind:value={baseUrl}
            class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
          />
        </div>
        <div>
          <label
            for="provider-api-key"
            class="text-muted-foreground block text-[10px] font-medium tracking-wider uppercase"
          >
            API key
          </label>
          <input
            id="provider-api-key"
            type="password"
            required
            autocomplete="off"
            bind:value={apiKey}
            class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
          />
        </div>
        {#if selectedProvider.id === 'eurouter'}
          <div>
            <label
              for="provider-rule-chat"
              class="text-muted-foreground block text-[10px] font-medium tracking-wider uppercase"
            >
              Chat routing rule ID
            </label>
            <input
              id="provider-rule-chat"
              required
              bind:value={ruleChat}
              placeholder="Rule UUID from your EUrouter dashboard"
              class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
            />
          </div>
          <div>
            <label
              for="provider-rule-embedding"
              class="text-muted-foreground block text-[10px] font-medium tracking-wider uppercase"
            >
              Embedding routing rule ID
            </label>
            <input
              id="provider-rule-embedding"
              required
              bind:value={ruleEmbedding}
              placeholder="Rule UUID from your EUrouter dashboard"
              class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
            />
          </div>
        {:else}
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                for="provider-model-chat"
                class="text-muted-foreground block text-[10px] font-medium tracking-wider uppercase"
              >
                Chat model
              </label>
              <input
                id="provider-model-chat"
                required
                list="provider-chat-model-options"
                bind:value={modelChat}
                placeholder="Select or type a model id"
                class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
              />
              <datalist id="provider-chat-model-options">
                {#each selectedProvider.chatModels as model (model.id)}
                  <option value={model.id}>{model.name}</option>
                {/each}
              </datalist>
            </div>
            {#if selectedEmbeddingsSupported}
              <div>
                <label
                  for="provider-model-embedding"
                  class="text-muted-foreground block text-[10px] font-medium tracking-wider uppercase"
                >
                  Embedding model
                </label>
                <input
                  id="provider-model-embedding"
                  required
                  list="provider-embedding-model-options"
                  bind:value={modelEmbedding}
                  placeholder="Select or type a model id"
                  class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
                />
                <datalist id="provider-embedding-model-options">
                  {#each selectedProvider.embeddingModels as model (model.id)}
                    <option value={model.id}>{model.name}</option>
                  {/each}
                </datalist>
              </div>
            {:else}
              <p class="text-muted-foreground text-xs leading-relaxed">
                This provider has no embedding models. Memory features need one — add an
                embedding-capable provider later under Settings → LLM.
              </p>
            {/if}
          </div>
        {/if}
        {#if error}
          <p class="text-destructive text-xs leading-relaxed">{error}</p>
        {/if}
        <button
          type="button"
          onclick={() => void connect()}
          disabled={connecting}
          class="flex h-11 w-full items-center justify-center bg-black text-sm font-medium text-white hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {#if connecting}
            <LoaderCircle class="size-4 animate-spin" strokeWidth={1.75} />
            <span class="ml-2">Connecting…</span>
          {:else}
            Connect
          {/if}
        </button>
        <p class="text-muted-foreground text-center text-xs leading-relaxed">
          The connection is verified with one real request before anything is saved.
        </p>
      </div>
    {:else if step === 'credentials' && (deviceFlow === 'github_copilot' || deviceFlow === 'openai_codex')}
      <div class="mt-8 space-y-3">
        <p class="text-muted-foreground text-xs">
          Model: <span class="font-medium">{chosenChatModel}</span>
        </p>
        <p class="text-sm leading-relaxed">
          At
          {#if verificationUri}
            <button
              type="button"
              class="font-medium underline underline-offset-2"
              onclick={() => {
                if (verificationUri) window.open(verificationUri, '_blank', 'noopener,noreferrer')
              }}
            >
              {verificationUri}
            </button>
          {/if}
          enter this one-time code:
        </p>
        <p class="border-2 border-black px-4 py-3 text-center text-lg font-medium tracking-[0.3em]">
          {userCode ?? '…'}
        </p>
        {#if connecting}
          <p class="text-muted-foreground flex items-center gap-2 text-xs">
            <LoaderCircle class="size-3.5 animate-spin" strokeWidth={1.75} />
            Waiting for you to authorize…
          </p>
        {/if}
        {#if error}
          <p class="text-destructive text-xs leading-relaxed">{error}</p>
        {/if}
      </div>
    {:else if step === 'credentials'}
      <div class="mt-8 space-y-3">
        <p class="text-muted-foreground text-xs">
          Model: <span class="font-medium">{chosenChatModel}</span>
        </p>
        <p class="text-sm leading-relaxed">
          A Claude sign-in page opened in a new tab. After approving, paste the
          authorization code — or the entire URL you were sent to — below.
        </p>
        {#if error}
          <p class="text-destructive text-xs leading-relaxed">{error}</p>
        {/if}
        <div>
          <label
            for="anthropic-paste-code"
            class="text-muted-foreground block text-[10px] font-medium tracking-wider uppercase"
          >
            Authorization code
          </label>
          <textarea
            id="anthropic-paste-code"
            rows="3"
            bind:value={pastedCode}
            placeholder="code#state — or the full redirect URL: http://localhost:53692/callback?code=…&state=…"
            class="focus:border-black mt-1 w-full border border-black/20 bg-white px-3 py-2 font-mono text-xs outline-none"
          ></textarea>
        </div>
        <button
          type="button"
          onclick={() => void connectAnthropicPaste()}
          disabled={pasteBusy || !pastedCode.trim()}
          class="flex h-11 w-full items-center justify-center bg-black text-sm font-medium text-white hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {#if pasteBusy}
            <LoaderCircle class="size-4 animate-spin" strokeWidth={1.75} />
            <span class="ml-2">Connecting…</span>
          {:else}
            Connect
          {/if}
        </button>
        {#if phase === 'connecting'}
          <p class="text-muted-foreground flex items-center gap-2 text-xs">
            <LoaderCircle class="size-3.5 animate-spin" strokeWidth={1.75} />
            Opening Claude sign-in…
          </p>
        {/if}
      </div>
    {/if}

    {#if step !== 'method' && step !== 'connected' && byokUiEnabled}
      <div class="mt-6 text-center">
        <button
          type="button"
          class="text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
          onclick={back}
        >
          ← Back
        </button>
      </div>
    {/if}
  </div>
</div>
