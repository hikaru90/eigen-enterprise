<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import StatusPill from '$lib/components/page/status-pill.svelte'
  import SpeechStatus from '$lib/components/settings/speech-status.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const providers = [
    { id: 'openrouter' as const, label: 'OpenRouter' },
    { id: 'eurouter' as const, label: 'EUrouter' },
  ]

  const SLOT_LABEL: Record<string, { label: string; hint: string }> = {
    chat: { label: 'Chat', hint: 'Writes: answers, drafts, summaries.' },
    stt: { label: 'Speech to text', hint: 'Every transcript: dictation, voice notes, calls.' },
    tts: { label: 'Text to speech', hint: "The assistant's voice." },
    decision: { label: 'Decisions', hint: 'Answers from a fixed set of choices (yes/no, one of several).' },
  }

  const eigenInferenceMissing = $derived(data.ai.useEigenInference && !data.ai.eigenInferenceAvailable)

  /** A dropdown saves as soon as a model is picked: the change submits its own form. */
  function submitOnChange(event: Event & { currentTarget: HTMLSelectElement }) {
    event.currentTarget.form?.requestSubmit()
  }
</script>

<svelte:head>
  <title>{docTitle('AI provider', 'Settings')}</title>
</svelte:head>

<h2 class="text-base font-semibold tracking-tight">AI provider</h2>
<p class="mt-1 text-sm text-muted-foreground">
  The models that do the thinking for your company: the chat, reading what you capture, voice notes
  and the assistant's voice. They are the company's, whoever uses them.
</p>

<div class="mt-8 space-y-8">
  <section class="space-y-3" data-testid="eigen-inference">
    <form
      method="post"
      action="?/setEigenInference"
      use:enhance
      class="flex items-start justify-between gap-4 rounded-lg border border-border p-4"
    >
      <input type="hidden" name="on" value={data.ai.useEigenInference ? 'false' : 'true'} />
      <div>
        <h3 class="text-sm font-semibold" id="eigen-inference-label">Use eigenInference</h3>
        <p class="mt-1 text-sm text-muted-foreground">
          {#if data.ai.useEigenInference}
            Every model call runs on eigenEnterprise's inference, billed per call in Activity. No keys
            to manage.
          {:else}
            Off: every model call runs on the company's own key (under Advanced).
          {/if}
        </p>
      </div>
      <button
        type="submit"
        role="switch"
        aria-checked={data.ai.useEigenInference}
        aria-labelledby="eigen-inference-label"
        disabled={!data.canManageAi}
        class="relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-2 -ring disabled:cursor-not-allowed disabled:opacity-50 {data
          .ai.useEigenInference
          ? 'bg-primary'
          : 'bg-input'}"
      >
        <span
          class="pointer-events-none block size-4 rounded-full bg-background transition-transform {data.ai
            .useEigenInference
            ? 'translate-x-[14px]'
            : 'translate-x-0'}"
        ></span>
      </button>
    </form>
    {#if eigenInferenceMissing}
      <p class="text-sm text-destructive" role="alert" data-testid="eigen-inference-missing">
        eigenInference is not connected on this server yet, so model calls fail. Turn it off and add
        the company's own key under Advanced.
      </p>
    {/if}
    {#if form?.aiMessage}
      <p class="text-sm text-muted-foreground" role="status">{form.aiMessage}</p>
    {/if}
  </section>

  <section class="space-y-3" data-testid="model-slots">
    <div>
      <h3 class="text-sm font-semibold">Models</h3>
      <p class="mt-1 text-sm text-muted-foreground">
        Each role runs on a model we checked is good enough for eigenEnterprise.
        {#if !data.canManageAi}Owners and admins choose them.{/if}
      </p>
    </div>

    <ul class="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {#each data.ai.slots as slot (slot.slot)}
        {@const meta = SLOT_LABEL[slot.slot]}
        {@const current = slot.options.find((o) => o.id === slot.model)}
        <li class="px-4 py-3">
          <form method="post" action="?/setSlot" use:enhance class="grid gap-1.5 sm:grid-cols-[12rem_1fr] sm:items-center">
            <input type="hidden" name="slot" value={slot.slot} />
            <div>
              <Label for="slot-{slot.slot}">{meta?.label ?? slot.slot}</Label>
              <p class="text-xs text-muted-foreground">{meta?.hint}</p>
            </div>
            <div class="space-y-1">
              <select
                id="slot-{slot.slot}"
                name="model"
                value={slot.model}
                disabled={!data.canManageAi}
                onchange={submitOnChange}
                class="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 -ring disabled:cursor-not-allowed disabled:opacity-60"
              >
                {#each slot.options as option (option.id)}
                  <option value={option.id}>{option.id}{option.recommended ? ' (recommended)' : ''}</option>
                {/each}
              </select>
              {#if current}
                <p class="text-xs text-muted-foreground">{current.note}</p>
              {/if}
            </div>
          </form>
        </li>
      {/each}
      <li class="grid gap-1.5 px-4 py-3 sm:grid-cols-[12rem_1fr] sm:items-center" data-testid="embedding-slot">
        <div>
          <p class="text-sm font-medium leading-none">Search</p>
          <p class="text-xs text-muted-foreground">Finds related memories (an embedding model).</p>
        </div>
        <div class="space-y-1">
          <p class="font-mono text-sm">{data.ai.embeddingModel ?? 'Set on first use'}</p>
          <p class="text-xs text-muted-foreground">
            Fixed for this install: changing it would mean re-reading everything the company has
            stored.
          </p>
        </div>
      </li>
    </ul>
    {#if form?.slotMessage}
      <p class="text-sm text-muted-foreground" role="status">{form.slotMessage}</p>
    {/if}
  </section>

  <SpeechStatus dictation={data.speech.dictation} models={data.speech.models} />

  <details class="group space-y-4" data-testid="advanced" open={!data.ai.useEigenInference}>
    <summary class="cursor-pointer text-sm font-semibold">Advanced: your own keys</summary>

    {#if data.isOwner}
      <section class="mt-4 space-y-3" data-testid="llm-providers">
        <p class="text-sm text-muted-foreground">
          Used when "Use eigenInference" is off. Connect a provider with its API key; the active one
          does all the work. Speech always needs an OpenRouter key.
        </p>

        <ul class="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {#each providers as item (item.id)}
            {@const configured = data.providers[item.id].configured}
            {@const isActive = data.activeProvider === item.id}
            <li>
              <a
                href={resolve(`/settings/llm/byok/${item.id}`)}
                class="flex items-center justify-between gap-3 px-4 py-3 text-sm outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 -ring"
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

      <section class="space-y-3" data-testid="eurouter-rules">
        <div>
          <h3 class="text-sm font-semibold">EUrouter routing rules</h3>
          <p class="mt-1 text-sm text-muted-foreground">
            Only for an EUrouter key: EUrouter picks its models by routing rule. Every other key runs
            on the models chosen above.
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
          <input type="hidden" name="provider" value="eurouter" />
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

          <div class="flex items-center gap-3">
            <Button type="submit" variant="outline" size="sm">Save rules</Button>
            {#if form?.modelMessage}
              <p class="text-sm text-muted-foreground">{form.modelMessage}</p>
            {/if}
          </div>
        </form>
      </section>
    {:else}
      <p class="mt-4 text-sm text-muted-foreground" data-testid="advanced-owner-only">
        The company's own keys are the owner's to manage.
      </p>
    {/if}
  </details>
</div>
