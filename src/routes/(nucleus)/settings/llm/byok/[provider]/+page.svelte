<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import { enhance } from '$app/forms'
  import { afterNavigate, goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const isEurouter = $derived(data.provider === 'eurouter')
  const label = $derived(isEurouter ? 'EUrouter' : 'OpenRouter')

  function applyProviderData(pd: PageData['providerData'] = data.providerData) {
    baseUrl = pd.baseUrl
    apiKey = pd.apiKey
    ruleChat = 'ruleChat' in pd ? (pd.ruleChat ?? '') : ''
    ruleEmbedding = 'ruleEmbedding' in pd ? (pd.ruleEmbedding ?? '') : ''
  }

  const pd0 = data.providerData
  let baseUrl = $state(pd0.baseUrl)
  let apiKey = $state(pd0.apiKey)
  let ruleChat = $state('ruleChat' in pd0 ? (pd0.ruleChat ?? '') : '')
  let ruleEmbedding = $state('ruleEmbedding' in pd0 ? (pd0.ruleEmbedding ?? '') : '')

  afterNavigate(() => {
    applyProviderData()
  })
</script>

<svelte:head>
  <title>{docTitle(label, 'AI provider', 'Settings')}</title>
</svelte:head>

<div class="space-y-4">
  <a
    href={resolve('/settings/llm')}
    class="text-muted-foreground inline-flex items-center gap-1 text-xs hover:text-foreground"
  >
    <ChevronLeft class="size-4" strokeWidth={1.75} />
    Back to AI provider
  </a>

  <div>
    <h2 class="text-base font-semibold tracking-tight">{label}</h2>
    <p class="mt-1 text-sm text-muted-foreground">Connect {label} with its API key.</p>
  </div>

  <form
    method="post"
    action="?/saveLlmConfig"
    use:enhance={() => {
      return async ({ result, update }) => {
        await update()
        if (result.type === 'success') {
          await goto(resolve('/settings/llm'))
        }
      }
    }}
    class="space-y-3 rounded-lg border border-border p-4 text-sm"
  >
    <input type="hidden" name="provider" value={data.provider} />
    <input type="hidden" name="setActive" value="true" />

    <div class="space-y-1">
      <Label for="baseUrl">Base URL</Label>
      <input
        id="baseUrl"
        type="url"
        name="baseUrl"
        bind:value={baseUrl}
        placeholder={isEurouter ? 'https://api.eurouter.ai/v1' : 'https://openrouter.ai/api/v1'}
        class="border-input bg-background text-foreground h-9 w-full border px-2.5 text-xs"
        required
      />
    </div>
    <div class="space-y-1">
      <Label for="apiKey">API key</Label>
      <input
        id="apiKey"
        type="password"
        name="apiKey"
        bind:value={apiKey}
        placeholder={isEurouter ? 'sk-...' : 'sk-or-...'}
        class="border-input bg-background text-foreground h-9 w-full border px-2.5 text-xs"
        required
      />
    </div>

    {#if isEurouter}
      <div class="space-y-1">
        <Label for="ruleChat">Chat rule UUID</Label>
        <input
          id="ruleChat"
          type="text"
          name="ruleChat"
          bind:value={ruleChat}
          class="border-input bg-background text-foreground h-9 w-full border px-2.5 font-mono text-xs"
        />
      </div>
      <div class="space-y-1">
        <Label for="ruleEmbedding">Embedding rule UUID</Label>
        <input
          id="ruleEmbedding"
          type="text"
          name="ruleEmbedding"
          bind:value={ruleEmbedding}
          class="border-input bg-background text-foreground h-9 w-full border px-2.5 font-mono text-xs"
        />
      </div>
    {:else}
      <p class="text-muted-foreground text-xs" data-testid="openrouter-models-note">
        The models are the company's choice under Settings → AI provider → Models; this key runs
        them.
      </p>
    {/if}

    <Button type="submit" variant="outline" size="sm" class="rounded-[4px]">Save</Button>
    {#if form?.llmMessage}
      <p class="text-muted-foreground text-xs">{form.llmMessage}</p>
    {/if}
  </form>
</div>
