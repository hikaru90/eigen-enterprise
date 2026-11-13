<script lang="ts">
  import Bold from '@lucide/svelte/icons/bold'
  import Code from '@lucide/svelte/icons/code'
  import Italic from '@lucide/svelte/icons/italic'
  import Link from '@lucide/svelte/icons/link'
  import Paperclip from '@lucide/svelte/icons/paperclip'
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal'
  import Smile from '@lucide/svelte/icons/smile'
  import Strikethrough from '@lucide/svelte/icons/strikethrough'
  import type { Snippet } from 'svelte'
  import { tick } from 'svelte'
  import VoiceDictation from '$lib/voice/voice-dictation.svelte'
  import { appendVoiceTranscript } from '$lib/voice/transcribe-voice-clip'
  import { applyFormat, insertAt, type Edit, type Format } from './composer'

  /**
   * The message box, Slack-style: a bordered box with a formatting row
   * (bold, italic, strikethrough, code, link — they insert Markdown), the
   * text, and a bottom row with attach, emoji, dictation and send. Enter sends,
   * Shift+Enter is a new line. Dictation appends its transcript to the text;
   * while a voice message exists the bar takes the bottom row.
   */
  let {
    value = $bindable(''),
    textarea = $bindable(null),
    placeholder,
    label,
    canSend,
    emoji,
    inputTestid,
    sendTestid,
    formTestid,
    hint = true,
    dragging = false,
    onsend,
    onattach,
    onpaste,
    ondragover,
    ondragleave,
    ondrop,
    above,
  }: {
    value?: string
    textarea?: HTMLTextAreaElement | null
    placeholder: string
    label: string
    canSend: boolean
    emoji: readonly string[]
    inputTestid: string
    sendTestid: string
    formTestid?: string
    hint?: boolean
    dragging?: boolean
    onsend: () => void
    /** Shows the attach button. */
    onattach?: () => void
    onpaste?: (e: ClipboardEvent) => void
    ondragover?: (e: DragEvent) => void
    ondragleave?: (e: DragEvent) => void
    ondrop?: (e: DragEvent) => void
    /** Pending files, errors: inside the box, above the text. */
    above?: Snippet
  } = $props()

  let emojiOpen = $state(false)
  let voiceActive = $state(false)

  async function addTranscript(text: string) {
    value = appendVoiceTranscript(value, text)
    await tick()
    textarea?.focus()
    textarea?.setSelectionRange(value.length, value.length)
  }

  async function apply(edit: Edit) {
    value = edit.text
    await tick()
    textarea?.focus()
    textarea?.setSelectionRange(edit.selectionStart, edit.selectionEnd)
  }

  function format(f: Format) {
    const el = textarea
    void apply(applyFormat(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, f))
  }

  function addEmoji(e: string) {
    emojiOpen = false
    const el = textarea
    void apply(insertAt(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, e))
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      if (canSend) onsend()
      return
    }
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    const k = e.key.toLowerCase()
    const shortcut: Format | null = k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'k' && e.shiftKey ? 'link' : null
    if (shortcut) {
      e.preventDefault()
      format(shortcut)
    }
  }

  const tools: Array<{ f: Format; label: string; icon: typeof Bold }> = [
    { f: 'bold', label: 'Bold (⌘B)', icon: Bold },
    { f: 'italic', label: 'Italic (⌘I)', icon: Italic },
    { f: 'strike', label: 'Strikethrough', icon: Strikethrough },
    { f: 'code', label: 'Code', icon: Code },
    { f: 'link', label: 'Link (⌘⇧K)', icon: Link },
  ]
</script>

<form
  class="px-4 pb-4 sm:px-5"
  data-testid={formTestid}
  onsubmit={(e) => {
    e.preventDefault()
    if (canSend) onsend()
  }}
  {ondragover}
  {ondragleave}
  {ondrop}
>
  <div
    class={[
      'rounded-xl border bg-background shadow-xs transition-colors focus-within:border-ring',
      dragging ? 'border-primary ring-2 ring-primary/30' : 'border-border',
    ]}
  >
    <div class="flex items-center gap-0.5 border-b border-border/70 px-1.5 py-1" role="toolbar" aria-label="Formatting">
      {#each tools as t (t.f)}
        <button
          type="button"
          class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label={t.label}
          title={t.label}
          data-testid="composer-format-{t.f}"
          onclick={() => format(t.f)}><t.icon class="size-4" /></button
        >
      {/each}
    </div>
    {@render above?.()}
    <textarea
      bind:this={textarea}
      bind:value
      rows="1"
      class="field-sizing-content block max-h-60 min-h-11 w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-6 outline-none placeholder:text-muted-foreground"
      {placeholder}
      aria-label={label}
      data-testid={inputTestid}
      onkeydown={onKey}
      {onpaste}
    ></textarea>
    <div class="relative flex items-center gap-0.5 px-1.5 pb-1.5">
      {#if !voiceActive}
      {#if onattach}
        <button
          type="button"
          class="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Attach files"
          title="Attach files (they’re saved to the Drive)"
          data-testid="messages-attach"
          onclick={onattach}><Paperclip class="size-4" /></button
        >
      {/if}
      <button
        type="button"
        class="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        aria-label="Insert emoji"
        title="Emoji"
        aria-expanded={emojiOpen}
        data-testid="composer-emoji"
        onclick={() => (emojiOpen = !emojiOpen)}><Smile class="size-4" /></button
      >
      {#if emojiOpen}
        <div
          class="absolute bottom-full left-1.5 z-20 mb-1 grid w-max grid-cols-5 gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
          role="menu"
          aria-label="Insert emoji"
        >
          {#each emoji as e (e)}
            <button
              type="button"
              role="menuitem"
              class="grid size-8 place-items-center rounded-md text-lg hover:bg-foreground/[0.06]"
              aria-label="Insert {e}"
              onclick={() => addEmoji(e)}>{e}</button
            >
          {/each}
        </div>
      {/if}
      {#if hint}
        <span class="ml-2 hidden truncate text-xs text-muted-foreground sm:inline">
          <kbd class="font-sans font-medium">Enter</kbd> to send · <kbd class="font-sans font-medium">Shift+Enter</kbd> for a new line
        </span>
      {/if}
      {/if}
      <VoiceDictation
        bind:active={voiceActive}
        class={voiceActive ? '' : 'ml-auto'}
        testid="{inputTestid}-voice"
        ontranscript={(text) => void addTranscript(text)}
      />
      {#if !voiceActive}
      <button
        type="submit"
        class={[
          'ml-1 grid h-8 w-10 place-items-center rounded-md transition-colors',
          canSend ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'text-muted-foreground',
        ]}
        disabled={!canSend}
        aria-label="Send"
        title="Send"
        data-testid={sendTestid}><SendHorizontal class="size-4" /></button
      >
      {/if}
    </div>
  </div>
</form>
