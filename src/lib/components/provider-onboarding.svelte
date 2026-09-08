<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { invalidateAll } from '$app/navigation'
  import { onMount } from 'svelte'

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
  type Step = 'method' | 'provider' | 'credentials' | 'connected'
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

  // Copilot device flow
  let deviceCode = $state<string | null>(null)
  let userCode = $state<string | null>(null)
  let verificationUri = $state<string | null>(null)
  let pollTimer: ReturnType<typeof setInterval> | null = null

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
    modelChat = entry.chatModels[0]?.id ?? ''
    modelEmbedding = entry.embeddingModels[0]?.id ?? ''
    step = 'credentials'
  }

  function chooseCopilot(): void {
    error = null
    selectedProvider = null
    deviceCode = null
    userCode = null
    verificationUri = null
    step = 'credentials'
    void startCopilot()
  }

  function chooseOpenRouterSignIn(): void {
    error = null
    void (async () => {
      phase = 'connecting'
      try {
        const res = await fetch('/api/onboarding/openrouter/authorize', { method: 'POST' })
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
        body: JSON.stringify({ deviceCode }),
      })
      const body = (await res.json().catch(() => null)) as
        | { status?: string; error?: string; models?: string[]; baseUrl?: string }
        | null
      if (body?.status === 'pending') return
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
      if (body?.status === 'connected') {
        connectedSummary = 'GitHub Copilot subscription connected'
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
    if (step === 'provider' || step === 'credentials') step = 'method'
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
            Sign in with your existing account (GitHub Copilot, OpenRouter)
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
            onclick={chooseCopilot}
          >
            <span class="block text-sm font-medium">GitHub Copilot</span>
            <span class="text-muted-foreground mt-0.5 block text-xs">
              Sign in with your GitHub account — no API key. Chat only.
            </span>
          </button>
          <button
            type="button"
            class="border-2 px-4 py-4 text-left transition-colors hover:border-black"
            onclick={chooseOpenRouterSignIn}
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
    {:else if step === 'credentials' && selectedProvider}
      <div class="mt-8 space-y-3">
        <p class="text-muted-foreground text-xs">
          {selectedProvider.name}
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
              list="catalog-chat-models"
              bind:value={modelChat}
              class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
            />
            <datalist id="catalog-chat-models">
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
                list="catalog-embedding-models"
                bind:value={modelEmbedding}
                class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
              />
              <datalist id="catalog-embedding-models">
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
    {:else if step === 'credentials'}
      <div class="mt-8 space-y-3">
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
