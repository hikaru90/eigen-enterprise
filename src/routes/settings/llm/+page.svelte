<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import Check from '@lucide/svelte/icons/check'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  let selectedProvider = $state<'eurouter' | 'openrouter'>(
    data.activeProvider === 'openrouter' ? 'openrouter' : 'eurouter',
  )

  const providers = [
    { id: 'openrouter' as const, label: 'OpenRouter' },
    { id: 'eurouter' as const, label: 'EUrouter' },
  ]
</script>

<div class="mx-auto max-w-2xl space-y-8 px-4 pb-8 pt-16">
  {#if data.isAdmin}
    <section class="space-y-3">
      <div>
        <h2 class="text-sm font-semibold">Model Configuration</h2>
        <p class="text-muted-foreground mt-1 text-xs">
          Override the default chat and embedding models. These settings apply to entity extraction,
          capture enrichment, and other LLM tasks.
          {#if data.byokConfigured}
            For full provider configuration (API keys, base URLs), use the provider entries below.
          {:else}
            For full provider configuration, set environment variables or configure a provider
            below.
          {/if}
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
        class="rounded-xl bg-muted px-3.5 py-3"
      >
        <input type="hidden" name="provider" value={selectedProvider} />
        <div class="space-y-3">
          <Label for="model-provider">Provider</Label>
          <select
            id="model-provider"
            bind:value={selectedProvider}
            class="border-input bg-background text-foreground h-9 w-full border px-2.5 text-xs"
          >
            <option value="eurouter">EUrouter</option>
            <option value="openrouter">OpenRouter</option>
          </select>

          {#if selectedProvider === 'openrouter'}
            <div class="space-y-1">
              <Label for="modelChat">Chat model</Label>
              <input
                id="modelChat"
                type="text"
                name="modelChat"
                value={data.providers?.openrouter?.modelChat ?? ''}
                placeholder="e.g., openai/gpt-4o-mini, anthropic/claude-3-haiku"
                class="border-input bg-background text-foreground h-9 w-full border px-2.5 text-xs"
              />
            </div>

            <div class="space-y-1">
              <Label for="modelEmbedding">Embedding model</Label>
              <input
                id="modelEmbedding"
                type="text"
                name="modelEmbedding"
                value={data.providers?.openrouter?.modelEmbedding ?? ''}
                placeholder="e.g., openai/text-embedding-3-small"
                class="border-input bg-background text-foreground h-9 w-full border px-2.5 text-xs"
              />
            </div>
          {:else}
            <div class="space-y-1">
              <Label for="ruleChat">Chat routing rule</Label>
              <input
                id="ruleChat"
                type="text"
                name="ruleChat"
                value={data.providers?.eurouter?.ruleChat ?? ''}
                placeholder="UUID routing rule for chat"
                class="border-input bg-background text-foreground h-9 w-full border px-2.5 font-mono text-xs"
              />
            </div>

            <div class="space-y-1">
              <Label for="ruleEmbedding">Embedding routing rule</Label>
              <input
                id="ruleEmbedding"
                type="text"
                name="ruleEmbedding"
                value={data.providers?.eurouter?.ruleEmbedding ?? ''}
                placeholder="UUID routing rule for embeddings"
                class="border-input bg-background text-foreground h-9 w-full border px-2.5 font-mono text-xs"
              />
            </div>
          {/if}

          <Button type="submit" variant="outline" size="sm" class="rounded-[4px]"
            >Save model config</Button
          >
          {#if form?.modelMessage}
            <p class="text-muted-foreground text-xs">{form.modelMessage}</p>
          {/if}
        </div>
      </form>
    </section>
  {/if}

  <section class="space-y-4 mt-8">
    <div>
      <h2 class="text-sm font-semibold">LLM providers</h2>
      <p class="text-muted-foreground mt-1 text-xs">
        Configure OpenRouter or EUrouter API keys for LLM calls (capture, chat, voice dictation, and
        embeddings).
      </p>
    </div>

    <div class="rounded-xl bg-muted px-3.5 py-3 text-sm">
      <ul class="divide-y divide-border/60">
        {#each providers as item (item.id)}
          {@const configured = data.providers[item.id].configured}
          {@const isActive = data.activeProvider === item.id}
          <li>
            <a
              href={resolve(`/settings/llm/byok/${item.id}`)}
              class="flex items-center justify-between gap-3 py-3 text-xs hover:bg-black/5 dark:hover:bg-white/5"
            >
              <span class="font-medium text-foreground">{item.label}</span>
              <span class="flex items-center gap-1.5 text-muted-foreground">
                {#if configured}
                  <Check
                    class="size-4 text-green-600 dark:text-green-400"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  {#if isActive}
                    <span class="text-foreground">Active</span>
                  {/if}
                {:else}
                  <span>Not configured &gt;</span>
                {/if}
              </span>
            </a>
          </li>
        {/each}
      </ul>
      {#if form?.llmMessage}
        <p class="text-muted-foreground mt-2 text-xs">{form.llmMessage}</p>
      {/if}
    </div>
  </section>
</div>
