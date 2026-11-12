<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { Button } from '$lib/components/ui/button'
  import { appendVoiceTranscript } from '$lib/voice/transcribe-voice-clip'
  import VoiceDictation from '$lib/voice/voice-dictation.svelte'
  import { DESCRIBE_TEXT_MAX } from '../types'

  /**
   * "Tell me about them": say it (dictation) or type it, freely — the AI picks
   * out the form's fields. A dictated part lands in the box (so you see what
   * was heard and can fix it) and is read right away; typed text is read on
   * "Fill in the form" (or Ctrl/⌘+Enter). The form keeps working by hand
   * either way. Speech needs OpenRouter (the mic says when it's missing);
   * typing works without it. `onread` asks the AI and fills the form; a
   * failure comes back here as its plain sentence.
   */
  let {
    summary,
    hint,
    placeholder,
    onread,
    open = false,
    testid,
  }: {
    /** The disclosure's label, e.g. "Tell me about them". */
    summary: string
    hint: string
    placeholder: string
    onread: (text: string) => Promise<void>
    /** Start unfolded. */
    open?: boolean
    testid: string
  } = $props()

  let text = $state('')
  let working = $state(false)
  let error = $state<string | null>(null)
  let voiceActive = $state(false)

  const trimmed = $derived(text.trim())
  const tooLong = $derived(trimmed.length > DESCRIBE_TEXT_MAX)
  const readable = $derived(trimmed !== '' && !tooLong && !working)

  async function read(): Promise<void> {
    if (!readable) return
    error = null
    working = true
    try {
      await onread(trimmed)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      working = false
    }
  }

  function ontranscript(t: string): void {
    text = appendVoiceTranscript(text, t)
    void read()
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void read()
    }
  }
</script>

<details class="group rounded-lg border border-border bg-muted/20" {open} data-testid={testid}>
  <summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium">{summary}</summary>
  <div class="grid gap-2 px-3 pb-3">
    <p class="text-xs text-muted-foreground" id="{testid}-hint">{hint}</p>
    <textarea
      bind:value={text}
      {onkeydown}
      rows="4"
      aria-label={summary}
      aria-describedby="{testid}-hint"
      aria-invalid={tooLong}
      {placeholder}
      disabled={working}
      class="min-h-20 w-full resize-y rounded-md border border-input bg-card px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-60 aria-invalid:border-destructive"
      data-testid="{testid}-text"
    ></textarea>
    {#if tooLong}
      <p class="text-xs text-destructive">At most {DESCRIBE_TEXT_MAX} characters ({trimmed.length} now).</p>
    {/if}
    {#if error}<p class="text-xs leading-relaxed text-destructive" role="alert" data-testid="{testid}-error">{error}</p>{/if}
    <div class="flex items-center gap-1.5">
      <VoiceDictation bind:active={voiceActive} disabled={working} testid="{testid}-voice" {ontranscript} />
      {#if !voiceActive}
        <Button type="button" size="sm" variant="outline" disabled={!readable} onclick={() => void read()} data-testid="{testid}-fill">
          {#if working}
            <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
            Reading…
          {:else}
            Fill in the form
          {/if}
        </Button>
      {/if}
    </div>
  </div>
</details>
