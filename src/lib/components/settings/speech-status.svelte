<script lang="ts">
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import {
    DICTATION_MISSING_MESSAGE,
    type SpeechFeature,
    type SpeechModelStatus,
    type SpeechReadiness,
  } from '$lib/voice/dictation-readiness'

  /**
   * Settings → AI provider, "Speech": dictation and the assistant's voice run on the company's
   * speech provider (OpenRouter, or Opper when eigenInference runs there), whatever chat
   * provider is active. Shows whether dictation can work (and what is missing), and on
   * OpenRouter each speech model's live endpoints — a model with none fails every call, so that
   * is shown as an alert, and a failed check never reads as fine.
   */
  let {
    dictation,
    models,
    providerLabel,
  }: { dictation: SpeechReadiness; models: SpeechModelStatus[]; providerLabel: string } = $props()

  const FEATURE_LABEL: Record<SpeechFeature, string> = {
    dictation: 'Dictation (speech to text)',
    voice: 'Assistant voice (text to speech)',
  }

  function providerLine(s: Extract<SpeechModelStatus, { endpoints: number }>): string {
    if (s.endpoints === 0) return 'No providers on OpenRouter — every call fails'
    return `${s.endpoints} ${s.endpoints === 1 ? 'provider' : 'providers'} (${s.providers.join(', ')})`
  }
</script>

<section class="space-y-3" data-testid="speech-status">
  <div>
    <h3 class="text-sm font-semibold">Speech</h3>
    <p class="mt-1 text-sm text-muted-foreground">
      Dictation and the assistant’s voice run on {providerLabel}, whichever provider does the
      chat.
    </p>
  </div>

  <ul class="divide-y divide-border overflow-hidden rounded-lg border border-border text-sm">
    <li class="flex items-start justify-between gap-3 px-4 py-3" data-testid="speech-dictation">
      <span class="font-medium text-foreground">Dictation</span>
      {#if dictation.ready}
        <span class="text-foreground/70">Ready</span>
      {:else}
        <span class="text-right text-destructive"
          >{DICTATION_MISSING_MESSAGE[dictation.missing]}</span
        >
      {/if}
    </li>
    {#each models as s (s.feature)}
      {@const dead = 'endpoints' in s && s.endpoints === 0}
      <li
        class="flex items-start justify-between gap-3 px-4 py-3"
        data-testid="speech-model-{s.feature}"
        role={dead ? 'alert' : undefined}
      >
        <span class="min-w-0">
          <span class="block font-medium text-foreground">{FEATURE_LABEL[s.feature]}</span>
          <span class="block truncate font-mono text-xs text-muted-foreground">{s.model}</span>
        </span>
        {#if 'error' in s}
          <ErrorNotice
            class="items-end text-right"
            error={`Couldn’t check: ${s.error}`}
            attempted={`Checking the OpenRouter endpoints of the speech model ${s.model} (Settings → AI provider)`}
          />
        {:else}
          <span class={['text-right', dead ? 'text-destructive' : 'text-foreground/70']}
            >{providerLine(s)}</span
          >
        {/if}
      </li>
    {/each}
  </ul>
</section>
