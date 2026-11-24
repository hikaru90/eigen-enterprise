<script lang="ts">
  import type { Snippet } from 'svelte'
  import Bold from '@lucide/svelte/icons/bold'
  import Code from '@lucide/svelte/icons/code'
  import Folder from '@lucide/svelte/icons/folder'
  import Italic from '@lucide/svelte/icons/italic'
  import Link from '@lucide/svelte/icons/link'
  import Paperclip from '@lucide/svelte/icons/paperclip'
  import Plus from '@lucide/svelte/icons/plus'
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal'
  import Smile from '@lucide/svelte/icons/smile'
  import Strikethrough from '@lucide/svelte/icons/strikethrough'
  import { tick } from 'svelte'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import AiMark from '$lib/coworkers/ai-mark.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { appendVoiceTranscript } from '$lib/voice/transcribe-voice-clip'
  import VoiceDictation from '$lib/voice/voice-dictation.svelte'
  import type { VoiceRecording } from '$lib/voice/voice-message'
  import { applyFormat, formatDriveFolderLink, insertAt, type DriveFolderOption, type Edit, type Format } from './composer'
  import DriveFolderPicker from './drive-folder-picker.svelte'
  import EmojiPicker from './emoji-picker.svelte'
  import { insertMention, matchMentions, mentionAt, type Mentionable } from './mention'

  /**
   * The message box, Slack-style: a bordered box with a formatting row
   * (bold, italic, strikethrough, code, link — they insert Markdown), the
   * text, and a bottom row with attach, emoji, dictation and send. Enter sends,
   * Shift+Enter is a new line. Dictation appends its transcript to the text
   * and hands the recording to `onrecording` (the box sending it keeps it for
   * playback); while a voice message exists the bar takes the bottom row.
   * Given `mentionables`, typing @ and letters lists the matching members
   * (./mention.ts): ↑/↓ move, Enter/Tab insert their handle, Esc closes — the
   * box is then a combobox over that listbox.
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
    ondraft,
    onattach,
    attachTestid = 'messages-attach',
    driveFolders = false,
    driveFolderTestid = 'composer-drive-folder',
    loadDriveFolders,
    onpaste,
    ondragover,
    ondragleave,
    ondrop,
    onrecording,
    above,
    mentionables,
    me,
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
    /** The text after every change the person makes (typing, formatting, emoji, dictation): the page keeps it as the draft. */
    ondraft?: (value: string) => void
    /** Shows the attach button. */
    onattach?: () => void
    attachTestid?: string
    /** Shows the Drive folder link picker button. */
    driveFolders?: boolean
    driveFolderTestid?: string
    loadDriveFolders?: (query: string, signal?: AbortSignal) => Promise<DriveFolderOption[]>
    onpaste?: (e: ClipboardEvent) => void
    ondragover?: (e: DragEvent) => void
    ondragleave?: (e: DragEvent) => void
    ondrop?: (e: DragEvent) => void
    /** A dictated recording, whose transcript was just appended: sent along, it plays back above the text. */
    onrecording?: (recording: VoiceRecording) => void
    /** Pending files, errors: inside the box, above the text. */
    above?: Snippet
    /** Who can be @mentioned here (the conversation's members): typing @ and letters lists the matches. */
    mentionables?: readonly Mentionable[] | null
    /** The writer, never suggested. */
    me?: string
  } = $props()

  const uid = $props.id()
  const listId = `${uid}-mentions`
  /** The @word at the caret, while the box has focus; null otherwise. */
  let mention = $state<{ start: number; query: string } | null>(null)
  /** The @word Esc closed the list for (by where its @ is): it stays closed until another one starts. */
  let dismissedAt = $state<number | null>(null)
  let activeIndex = $state(0)
  const suggestions = $derived(
    mention && mentionables && mention.start !== dismissedAt ? matchMentions(mentionables, mention.query, { exclude: me }) : [],
  )
  const suggesting = $derived(suggestions.length > 0)
  const optionId = (i: number) => `${uid}-mention-${i}`

  /** Reads the @word at the caret after the text or the caret moved. */
  function syncMention() {
    const el = textarea
    if (!mentionables || !el) return
    const next = el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart) : null
    if (next?.start !== mention?.start || next?.query !== mention?.query) activeIndex = 0
    if (next?.start !== dismissedAt) dismissedAt = null
    mention = next
  }

  function closeMentions() {
    mention = null
  }

  function pickMention(member: Mentionable) {
    const at = mention
    if (!at) return
    const el = textarea
    mention = null
    void apply(insertMention(value, at.start, el?.selectionStart ?? value.length, member))
  }

  /** Keys while the list is open: ↑/↓ move, Enter/Tab insert, Esc closes. True when the key was the list's. */
  function mentionKey(e: KeyboardEvent): boolean {
    if (!suggesting || e.isComposing) return false
    const n = suggestions.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      return true
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault()
      pickMention(suggestions[Math.min(activeIndex, n - 1)])
      return true
    }
    if (e.key === 'Escape') {
      // The page's own Esc (closing a picker, cancelling a reply) waits for the next one.
      e.preventDefault()
      dismissedAt = mention?.start ?? null
      return true
    }
    return false
  }

  let emojiOpen = $state(false)
  /** The full picker instead of the quick row ("More emoji"). */
  let emojiFull = $state(false)
  let folderOpen = $state(false)
  let voiceActive = $state(false)

  async function addTranscript(text: string, recording: VoiceRecording) {
    value = appendVoiceTranscript(value, text)
    ondraft?.(value)
    onrecording?.(recording)
    await tick()
    textarea?.focus()
    textarea?.setSelectionRange(value.length, value.length)
  }

  async function apply(edit: Edit) {
    value = edit.text
    ondraft?.(value)
    await tick()
    textarea?.focus()
    textarea?.setSelectionRange(edit.selectionStart, edit.selectionEnd)
  }

  function format(f: Format) {
    const el = textarea
    void apply(applyFormat(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, f))
  }

  function toggleEmoji() {
    folderOpen = false
    emojiFull = false
    emojiOpen = !emojiOpen
  }

  function closeEmoji() {
    emojiOpen = false
    emojiFull = false
    textarea?.focus()
  }

  function addEmoji(e: string) {
    emojiOpen = false
    emojiFull = false
    const el = textarea
    void apply(insertAt(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, e))
  }

  function toggleFolder() {
    emojiOpen = false
    emojiFull = false
    folderOpen = !folderOpen
  }

  function closeFolder() {
    folderOpen = false
    textarea?.focus()
  }

  function addDriveFolder(folder: DriveFolderOption) {
    folderOpen = false
    const el = textarea
    void apply(
      insertAt(
        value,
        el?.selectionStart ?? value.length,
        el?.selectionEnd ?? value.length,
        formatDriveFolderLink(folder),
      ),
    )
  }

  function onKey(e: KeyboardEvent) {
    if (mentionKey(e)) return
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
    <div class="relative">
      {#if suggesting}
        <ul
          id={listId}
          role="listbox"
          aria-label={m.messages_mention_list()}
          class="absolute bottom-full left-1.5 z-20 mb-1 max-h-80 w-80 max-w-[calc(100%-0.75rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
          data-testid="{inputTestid}-mentions"
        >
          {#each suggestions as s, i (s.id)}
            <li
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              class={[
                'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                i === activeIndex ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.04]',
              ]}
              data-testid="composer-mention"
              data-id={s.id}
              data-kind={s.kind}
              onmousedown={(e) => e.preventDefault()}
              onmouseenter={() => (activeIndex = i)}
              onclick={() => pickMention(s)}
            >
              <UserAvatar name={s.name} image={s.image ?? null} size="sm" />
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="truncate font-medium">{s.name}</span>
                  {#if s.kind === 'coworker'}<AiMark />{/if}
                </span>
                <span class="block truncate text-xs text-muted-foreground">@{s.handle}</span>
              </span>
            </li>
          {/each}
        </ul>
      {/if}
      <textarea
        bind:this={textarea}
        bind:value
        rows="1"
        class="field-sizing-content block max-h-60 min-h-11 w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-6 outline-none placeholder:text-muted-foreground"
        {placeholder}
        role={mentionables ? 'combobox' : undefined}
        aria-label={label}
        aria-autocomplete={mentionables ? 'list' : undefined}
        aria-haspopup={mentionables ? 'listbox' : undefined}
        aria-expanded={mentionables ? suggesting : undefined}
        aria-controls={suggesting ? listId : undefined}
        aria-activedescendant={suggesting ? optionId(activeIndex) : undefined}
        data-testid={inputTestid}
        onkeydown={onKey}
        onkeyup={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) syncMention()
        }}
        oninput={(e) => {
          ondraft?.(e.currentTarget.value)
          syncMention()
        }}
        onclick={syncMention}
        onblur={closeMentions}
        {onpaste}
      ></textarea>
    </div>
    <div class="relative flex items-center gap-0.5 px-1.5 pb-1.5">
      {#if !voiceActive}
      {#if onattach}
        <button
          type="button"
          class="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Attach files"
          title="Attach files (they’re saved to the Drive)"
          data-testid={attachTestid}
          onclick={onattach}><Paperclip class="size-4" /></button
        >
      {/if}
      {#if driveFolders}
        <button
          type="button"
          class="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Link Drive folder"
          title="Link a Drive folder"
          aria-expanded={folderOpen}
          data-testid={driveFolderTestid}
          onclick={toggleFolder}><Folder class="size-4" /></button
        >
      {/if}
      <button
        type="button"
        class="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        aria-label="Insert emoji"
        title="Emoji"
        aria-expanded={emojiOpen}
        data-testid="composer-emoji"
        onclick={toggleEmoji}><Smile class="size-4" /></button
      >
      {#if folderOpen}
        <div class="absolute bottom-full left-1.5 z-20 mb-1">
          <DriveFolderPicker
            load={loadDriveFolders}
            onpick={addDriveFolder}
            onclose={closeFolder}
          />
        </div>
      {/if}
      {#if emojiOpen && emojiFull}
        <div class="absolute bottom-full left-1.5 z-20 mb-1">
          <EmojiPicker label="Insert emoji" onpick={addEmoji} onclose={closeEmoji} />
        </div>
      {:else if emojiOpen}
        <div
          class="absolute bottom-full left-1.5 z-20 mb-1 grid w-max grid-cols-6 gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
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
          <button
            type="button"
            role="menuitem"
            class="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="More emoji"
            title="More emoji"
            data-testid="composer-emoji-more"
            onclick={() => (emojiFull = true)}><Plus class="size-4" /></button
          >
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
        ontranscript={(text, recording) => void addTranscript(text, recording)}
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
