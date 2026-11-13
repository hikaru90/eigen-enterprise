<script lang="ts">
  import type { AssistantController } from './assistant-controller.svelte'
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close'
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import { onMount } from 'svelte'

  /**
   * The shell's top bar (polish P-1): one field to ask the company's
   * assistant from any page. ⌘K / Ctrl+K focuses it from anywhere; Enter
   * opens the panel on the right with the answer streaming in.
   */
  let { assistant }: { assistant: AssistantController } = $props()

  let value = $state('')
  let inputEl = $state<HTMLInputElement | undefined>(undefined)
  // Which modifier the hint names; decided in the browser (the server cannot know).
  let isMac = $state(false)

  onMount(() => {
    isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    assistant.barInput = inputEl ?? null
    return () => {
      if (assistant.barInput === inputEl) assistant.barInput = null
    }
  })

  function submit(event: SubmitEvent): void {
    event.preventDefault()
    const text = value.trim()
    if (!text || assistant.chat.busy) return
    value = ''
    assistant.ask(text)
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      assistant.focusBar()
    }
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') inputEl?.blur()
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- The website's "Ask the assistant" pill, in mist: an ink icon circle with the coral spark, the field, a ⌘K chip. -->
<div class="flex min-w-0 flex-1 items-center gap-2" data-testid="assistant-bar">
  <form
    class="relative flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-card pr-1.5 pl-1 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 hover:bg-accent"
    onsubmit={submit}
    role="search"
  >
    <span class="ico ico-ink size-7" aria-hidden="true">
      <Sparkles class="size-3.5 text-coral" strokeWidth={2} />
    </span>
    <input
      bind:this={inputEl}
      bind:value
      onkeydown={onInputKeydown}
      type="text"
      enterkeyhint="send"
      autocomplete="off"
      placeholder="Ask the assistant…"
      aria-label="Ask the assistant"
      aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
      data-testid="assistant-bar-input"
      class="h-full w-full min-w-0 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
    />
    <kbd
      class="chip chip-line pointer-events-none hidden shrink-0 text-muted-foreground sm:inline-flex"
      data-testid="assistant-bar-shortcut"
      aria-hidden="true">{isMac ? '⌘' : 'Ctrl'} K</kbd
    >
  </form>
  <button
    type="button"
    class="flex size-9 shrink-0 items-center justify-center rounded-full bg-card text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
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
