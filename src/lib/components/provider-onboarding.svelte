<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  let { byokUiEnabled = true }: { byokUiEnabled?: boolean } = $props()

  type Phase = 'idle' | 'connecting' | 'connected'

  let provider = $state<'openrouter' | 'eurouter'>('openrouter')
  let baseUrl = $state('')
  let apiKey = $state('')
  let modelChat = $state('')
  let modelEmbedding = $state('')
  let ruleChat = $state('')
  let ruleEmbedding = $state('')
  let phase = $state<Phase>('idle')
  let error = $state<string | null>(null)
  let connectedSummary = $state<string | null>(null)

  const connecting = $derived(phase === 'connecting')

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

  async function connect() {
    if (connecting || phase === 'connected') return
    error = null
    phase = 'connecting'
    const input = {
      provider,
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
      connectedSummary = `${test.model} · ${test.latencyMs}ms`
      phase = 'connected'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      phase = 'idle'
    }
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
      Your agent runs on your own gateway key. Credentials stay on this instance — nothing is
      sent anywhere else.
    </p>

    {#if !byokUiEnabled}
      <div class="mt-8 border border-black/15 p-4">
        <p class="text-sm leading-relaxed">
          This deployment manages AI provider credentials centrally. The operator of this
          deployment configures them on the server (provider environment variables) — once they
          do, the workspace opens by itself.
        </p>
      </div>
    {:else if phase === 'connected'}
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
    {:else}
      <div class="mt-8 space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <button
            type="button"
            onclick={() => (provider = 'openrouter')}
            class="border-2 px-4 py-3 text-left transition-colors {provider === 'openrouter'
              ? 'border-black'
              : 'border-black/15 hover:border-black/40'}"
            aria-pressed={provider === 'openrouter'}
          >
            <span class="block text-sm font-medium">OpenRouter</span>
            <span class="text-muted-foreground mt-0.5 block text-xs">Any model, one marketplace</span>
          </button>
          <button
            type="button"
            onclick={() => (provider = 'eurouter')}
            class="border-2 px-4 py-3 text-left transition-colors {provider === 'eurouter'
              ? 'border-black'
              : 'border-black/15 hover:border-black/40'}"
            aria-pressed={provider === 'eurouter'}
          >
            <span class="block text-sm font-medium">EUrouter</span>
            <span class="text-muted-foreground mt-0.5 block text-xs">Routing rules, EU residency</span>
          </button>
        </div>

        <div class="space-y-3">
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
              placeholder={provider === 'openrouter'
                ? 'https://openrouter.ai/api/v1'
                : 'https://api.eurouter.ai/v1'}
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
          {#if provider === 'openrouter'}
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
                bind:value={modelChat}
                placeholder="openai/gpt-4o-mini"
                class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
              />
            </div>
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
                bind:value={modelEmbedding}
                placeholder="openai/text-embedding-3-small"
                class="focus:border-black mt-1 h-10 w-full border border-black/20 bg-white px-3 text-sm outline-none"
              />
            </div>
          {:else}
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
          {/if}
        </div>

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
    {/if}
  </div>
</div>
