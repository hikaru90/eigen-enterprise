<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import StatusPill from '$lib/components/page/status-pill.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  let selectedProvider = $state<'eurouter' | 'openrouter'>(
    data.activeProvider === 'openrouter' ? 'openrouter' : 'eurouter',
  )

  const providers = [
    { id: 'openrouter' as const, label: 'OpenRouter' },
    { id: 'eurouter' as const, label: 'EUrouter' },
  ]
</script>

<svelte:head>
  <title>{docTitle('AI provider', 'Settings')}</title>
</svelte:head>

<h2 class="text-base font-semibold tracking-tight">AI provider</h2>
<p class="mt-1 text-sm text-muted-foreground">
  The service that does the thinking for your company: the chat, reading what you capture, and voice
  notes.
</p>

<div class="mt-8 space-y-8">
  <section class="space-y-3" data-testid="llm-providers">
    <div>
      <h3 class="text-sm font-semibold">Providers</h3>
      <p class="mt-1 text-sm text-muted-foreground">
        Connect one with its API key. The active one does all the work.
      </p>
    </div>

    <ul class="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {#each providers as item (item.id)}
        {@const configured = data.providers[item.id].configured}
        {@const isActive = data.activeProvider === item.id}
        <li>
          <a
            href={resolve(`/settings/llm/byok/${item.id}`)}
            class="flex items-center justify-between gap-3 px-4 py-3 text-sm outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span class="font-medium text-foreground">{item.label}</span>
            {#if configured}
              <StatusPill label={isActive ? 'Active' : 'Connected'} on={isActive} />
            {:else}
              <span class="text-muted-foreground">Set up →</span>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
    {#if form?.llmMessage}
      <p class="text-sm text-muted-foreground">{form.llmMessage}</p>
    {/if}
  </section>

  {#if data.isAdmin}
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold">Models</h3>
        <p class="mt-1 text-sm text-muted-foreground">
          Optional. Choose which models the provider uses; leave a field empty to keep the default.
          {#if !data.byokConfigured}Connect a provider above first.{/if}
        </p>
      </div>

      <form
        method="post"
        action="?/saveModelConfig"
        use:enhance={() => {
          return async ({ update }) => {
            await update()
          }
        }}
        class="space-y-4 rounded-lg border border-border p-4"
      >
        <input type="hidden" name="provider" value={selectedProvider} />
        <div class="space-y-1.5">
          <Label for="model-provider">Provider</Label>
          <select
            id="model-provider"
            bind:value={selectedProvider}
            class="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <option value="eurouter">EUrouter</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </div>

        {#if selectedProvider === 'openrouter'}
          <div class="space-y-1.5">
            <Label for="modelChat">Chat model</Label>
            <Input
              id="modelChat"
              type="text"
              name="modelChat"
              value={data.providers?.openrouter?.modelChat ?? ''}
              placeholder="e.g. openai/gpt-4o-mini"
            />
          </div>
          <div class="space-y-1.5">
            <Label for="modelEmbedding">Search model</Label>
            <Input
              id="modelEmbedding"
              type="text"
              name="modelEmbedding"
              value={data.providers?.openrouter?.modelEmbedding ?? ''}
              placeholder="e.g. openai/text-embedding-3-small"
            />
            <p class="text-xs text-muted-foreground">
              Used to find related memories (an embedding model).
            </p>
          </div>
        {:else}
          <div class="space-y-1.5">
            <Label for="ruleChat">Chat routing rule</Label>
            <Input
              id="ruleChat"
              type="text"
              name="ruleChat"
              value={data.providers?.eurouter?.ruleChat ?? ''}
              placeholder="Routing rule ID from EUrouter"
              class="font-mono"
            />
          </div>
          <div class="space-y-1.5">
            <Label for="ruleEmbedding">Search routing rule</Label>
            <Input
              id="ruleEmbedding"
              type="text"
              name="ruleEmbedding"
              value={data.providers?.eurouter?.ruleEmbedding ?? ''}
              placeholder="Routing rule ID from EUrouter"
              class="font-mono"
            />
          </div>
        {/if}

        <div class="flex items-center gap-3">
          <Button type="submit" variant="outline" size="sm">Save models</Button>
          {#if form?.modelMessage}
            <p class="text-sm text-muted-foreground">{form.modelMessage}</p>
          {/if}
        </div>
      </form>
    </section>
  {/if}
</div>
