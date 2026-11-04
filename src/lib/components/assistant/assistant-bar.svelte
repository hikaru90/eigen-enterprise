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
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

  onMount(() => {
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

<div class="flex min-w-0 flex-1 items-center gap-2" data-testid="assistant-bar">
  <form class="relative flex min-w-0 flex-1 items-center" onsubmit={submit} role="search">
    <Sparkles
      class="pointer-events-none absolute left-2.5 size-4 text-foreground/45"
      aria-hidden="true"
      strokeWidth={1.75}
    />
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
      class="h-8 w-full min-w-0 rounded-md border border-border bg-background pr-14 pl-8 text-sm text-foreground outline-none placeholder:text-foreground/45 hover:border-foreground/25 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40"
    />
    <kbd
      class="pointer-events-none absolute right-2 hidden items-center gap-0.5 rounded border border-border bg-muted/60 px-1.5 py-px font-sans text-[10px] font-medium text-foreground/55 sm:inline-flex"
      data-testid="assistant-bar-shortcut"
      aria-hidden="true">{isMac ? '⌘' : 'Ctrl'} K</kbd
    >
  </form>
  <button
    type="button"
    class="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/60 outline-none hover:bg-primary/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
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
