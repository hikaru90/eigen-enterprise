<script lang="ts">
  import type { AssistantController } from './assistant-controller.svelte'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close'
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import { onMount } from 'svelte'
  import { dictateInto } from '$lib/voice/dictation-insert'
  import VoiceDictation from '$lib/voice/voice-dictation.svelte'
  import OneDoorChip from './one-door-chip.svelte'

  /**
   * The shell's top bar (polish P-1): one field to ask the company's
   * assistant from any page. ⌘K / Ctrl+K focuses it from anywhere; Enter
   * opens the panel on the right with the answer streaming in.
   *
   * Spotlight (Contribute ccb12fab): at rest it is a pill in the top bar;
   * once it has focus (a click, ⌘K, a page's "Ask" button via focusBar) the
   * same field floats centred in the upper third over a dimmed page — a
   * modal dialog that keeps focus inside. Esc or a click on the page closes
   * it and gives focus back to where it came from; asking closes it and the
   * answer streams into the panel as before. Always the one input, so ⌘K,
   * focusBar() and the draft stay exactly as they were.
   *
   * Dictation (plan/shared-memory-voice-agent-tools.md §2): the mic sits in the pill next to
   * the field, the same control as Contribute. A tap opens the spotlight; while recording the
   * voice bar takes the field's row; Done puts the words in at the cursor and gives the field
   * focus back — the person reads, edits and presses Enter. Nothing is asked by itself.
   *
   * The one door (plan/concept-memory-one-door.md M1): Enter goes to memory.route_input first —
   * Jev decides; only a question or a reminder opens the panel. The chip under the pill says
   * what was filed and lets the person change it.
   */
  let { assistant }: { assistant: AssistantController } = $props()

  let value = $state('')
  let inputEl = $state<HTMLInputElement | undefined>(undefined)
  let dialogEl = $state<HTMLDivElement | undefined>(undefined)
  // Which modifier the hint names; decided in the browser (the server cannot know).
  let isMac = $state(false)
  let active = $state(false)
  /** The voice bar holds the row (recording, transcribing or saying why it can't). */
  let voiceActive = $state(false)
  /** The person put the cursor in the field (dictation goes there, else after the text). */
  let cursorPlaced = false
  /** Where focus was before the spotlight took it; it goes back there on close. */
  let returnTo: HTMLElement | null = null

  onMount(() => {
    isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    assistant.barInput = inputEl ?? null
    return () => {
      if (assistant.barInput === inputEl) assistant.barInput = null
    }
  })

  function inside(node: EventTarget | null): boolean {
    return node instanceof Node && Boolean(dialogEl?.contains(node))
  }

  function onFocusIn(event: FocusEvent): void {
    if (active) return
    const from = event.relatedTarget
    returnTo = from instanceof HTMLElement && !inside(from) ? from : null
    active = true
  }

  /** Focus left by other means (another window, the composer after asking): just close. */
  function onFocusOut(event: FocusEvent): void {
    if (inside(event.relatedTarget)) return
    close(false)
  }

  function close(restoreFocus: boolean): void {
    if (!active) return
    active = false
    const target = returnTo
    returnTo = null
    if (!restoreFocus) return
    if (target?.isConnected) target.focus()
    else inputEl?.blur()
  }

  function ontranscript(text: string): void {
    if (!inputEl) throw new Error('assistant bar: the transcript arrived after the field went away')
    dictateInto(inputEl, text, cursorPlaced)
    cursorPlaced = true
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault()
    const text = value.trim()
    if (voiceActive || !text || assistant.chat.busy || assistant.door.busy) return
    value = ''
    close(false)
    inputEl?.blur()
    // The one door: Jev routes first; only a question (or a reminder) opens the chat.
    void assistant.door.submit(text)
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      assistant.focusBar()
    }
  }

  function onDialogKeydown(event: KeyboardEvent): void {
    if (!active) return
    if (event.key === 'Escape') {
      // Handled here: the panel's own Esc (which closes the panel) leaves it alone.
      event.preventDefault()
      close(true)
      return
    }
    if (event.key !== 'Tab' || !dialogEl) return
    // Focus trap: Tab and Shift+Tab cycle through the dialog's own controls.
    const focusables = [...dialogEl.querySelectorAll<HTMLElement>('input, button:not([disabled])')].filter((el) =>
      el.checkVisibility(),
    )
    if (focusables.length === 0) return
    event.preventDefault()
    const at = focusables.indexOf(document.activeElement as HTMLElement)
    const next = (at + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length
    focusables[next].focus()
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if active}
  <!-- The dimmed page: a click anywhere on it closes the spotlight. Pressing it
       must not move focus first (that would close without giving focus back). -->
  <button
    type="button"
    tabindex="-1"
    aria-label="Close"
    class="fixed inset-0 z-[55] cursor-default bg-overlay/40 backdrop-blur-[2px]"
    onmousedown={(event) => event.preventDefault()}
    onclick={() => close(true)}
    data-testid="assistant-spotlight-backdrop"
  ></button>
{/if}

<!-- The ask pill on the frame: the website's yellow assistant spark, the field, a ⌘K chip. -->
<div class="flex min-w-0 flex-1 items-center gap-2" data-testid="assistant-bar">
  <!-- The slot keeps the pill's room in the top bar while the field floats. -->
  <div class="relative flex h-10 min-w-0 flex-1">
    <div class="absolute top-full left-0 z-[54] mt-1 max-w-full">
      <OneDoorChip door={assistant.door} />
    </div>
    <div
      bind:this={dialogEl}
      role={active ? 'dialog' : undefined}
      aria-modal={active ? 'true' : undefined}
      aria-label={active ? 'Ask the company brain' : undefined}
      class={active
        ? 'fixed inset-x-4 top-[18vh] z-[56] mx-auto flex h-14 max-w-2xl'
        : 'flex h-full min-w-0 flex-1'}
      onfocusin={onFocusIn}
      onfocusout={onFocusOut}
      onkeydown={onDialogKeydown}
      data-testid="assistant-spotlight"
    >
      <form
        class={[
          'ask-pill relative flex h-full min-w-0 flex-1 items-center rounded-full transition-colors focus-within:ring-2 focus-within:ring-ring',
          active ? 'gap-3 pr-2 pl-2 shadow-2xl' : 'gap-2.5 pr-1.5 pl-1 hover:bg-accent',
        ]}
        onsubmit={submit}
        role="search"
      >
        <span
          class={['mark mark-yellow rounded-full', active ? 'size-10' : 'size-8']}
          aria-hidden="true"
          data-testid="assistant-bar-spark"
        >
          <Sparkles class={active ? 'size-5' : 'size-4'} strokeWidth={2} />
        </span>
        <input
          bind:this={inputEl}
          bind:value
          type="text"
          enterkeyhint="send"
          autocomplete="off"
          placeholder="Ask the company brain…"
          aria-label="Ask the company brain"
          aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
          data-testid="assistant-bar-input"
          onfocus={() => (cursorPlaced = true)}
          class={[
            'h-full w-full min-w-0 border-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground',
            active ? 'text-base' : 'text-sm',
            voiceActive && 'hidden',
          ]}
        />
        <!-- At rest a press must not move focus first: that floats the spotlight away from
             under the pointer and the tap is lost. The tap records; the bar's Done button
             takes focus and opens the spotlight around it. -->
        <span
          role="presentation"
          class={['flex items-center', voiceActive ? 'min-w-0 flex-1' : 'shrink-0', !active && 'pr-1']}
          onmousedown={(event) => {
            if (!active) event.preventDefault()
          }}
        >
          <VoiceDictation
            bind:active={voiceActive}
            testid="assistant-bar-voice"
            {ontranscript}
            onclose={() => inputEl?.focus({ preventScroll: true })}
          />
        </span>
        {#if voiceActive}
          <!-- the voice bar holds the row: no Esc hint or Ask until the words are in -->
        {:else if active}
          <kbd
            class="chip chip-line pointer-events-none hidden shrink-0 text-muted-foreground sm:inline-flex"
            data-testid="assistant-spotlight-hint"
            aria-hidden="true">Esc</kbd
          >
          <button
            type="submit"
            class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            aria-label="Ask"
            disabled={!value.trim() || assistant.chat.busy || assistant.door.busy}
            data-testid="assistant-spotlight-submit"
          >
            <ArrowUp class="size-5" aria-hidden="true" strokeWidth={2} />
          </button>
        {:else}
          <kbd
            class="chip chip-line pointer-events-none hidden shrink-0 text-muted-foreground sm:inline-flex"
            data-testid="assistant-bar-shortcut"
            aria-hidden="true">{isMac ? '⌘' : 'Ctrl'} K</kbd
          >
        {/if}
      </form>
    </div>
  </div>
  <button
    type="button"
    class="flex size-10 shrink-0 items-center justify-center rounded-full bg-card text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    aria-label={assistant.open ? 'Close the assistant' : 'Open the assistant'}
    aria-expanded={assistant.open}
    aria-controls="assistant-panel"
    onclick={() => assistant.toggle()}
    data-testid="assistant-toggle"
  >
    {#if assistant.open}
      <PanelRightClose class="size-4" aria-hidden="true" strokeWidth={1.75} />
    {:else}
      <PanelRightOpen class="size-4" aria-hidden="true" strokeWidth={1.75} />
    {/if}
  </button>
</div>
