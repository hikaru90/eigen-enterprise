<script lang="ts">
  import type { AssistantController } from './assistant-controller.svelte'
  import type { AssistantTab } from './types'
  import SquarePen from '@lucide/svelte/icons/square-pen'
  import X from '@lucide/svelte/icons/x'
  import AssistantActivity from './assistant-activity.svelte'
  import AssistantChatView from './assistant-chat-view.svelte'
  import AssistantHistory from './assistant-history.svelte'
  import { PANEL_MIN_WIDTH, panelMaxWidth } from './panel-width'

  /**
   * The assistant panel (polish P-1): docked on the right of the page on
   * desktop — resizable by dragging its left edge (or with the arrow keys on
   * the edge), collapsible — and a full-screen sheet on phones. It lives in
   * the shell, so the conversation survives client-side navigation.
   */
  let { assistant, language }: { assistant: AssistantController; language: string } = $props()

  const tabs: Array<{ id: AssistantTab; label: string }> = [
    { id: 'chat', label: 'Chat' },
    { id: 'history', label: 'History' },
    { id: 'activity', label: 'Activity' },
  ]
  /** One arrow-key press on the resize edge. */
  const KEY_STEP = 24

  let drag: { pointerId: number; startX: number; startWidth: number } | null = null
  let maxWidth = $state(
    typeof window === 'undefined' ? PANEL_MIN_WIDTH : panelMaxWidth(window.innerWidth),
  )

  function isEditable(el: Element | null): boolean {
    if (!(el instanceof HTMLElement)) return false
    return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !assistant.open || event.defaultPrevented) return
    // Esc in a field leaves the field first; Esc elsewhere closes the panel.
    if (isEditable(document.activeElement)) return
    assistant.close()
  }

  function onWindowResize(): void {
    maxWidth = panelMaxWidth(window.innerWidth)
    assistant.resizeTo(assistant.width)
  }

  // The drag follows the pointer on the window (not pointer capture), so it
  // keeps going over the page and the panel's own content.
  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: assistant.width }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return
    // The edge is on the left: moving left widens the panel.
    assistant.resizeTo(drag.startWidth + (drag.startX - event.clientX))
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag = null
    assistant.commitWidth()
  }

  function onEdgeKeydown(event: KeyboardEvent): void {
    const step = event.key === 'ArrowLeft' ? KEY_STEP : event.key === 'ArrowRight' ? -KEY_STEP : 0
    if (!step) return
    event.preventDefault()
    assistant.resizeTo(assistant.width + step)
    assistant.commitWidth()
  }

  function onTabKeydown(event: KeyboardEvent, index: number): void {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    assistant.selectTab(next.id)
    document.getElementById(`assistant-tab-${next.id}`)?.focus()
  }
</script>

<svelte:window
  onkeydown={onWindowKeydown}
  onresize={onWindowResize}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
/>

{#if assistant.open}
  <aside
    id="assistant-panel"
    aria-label="Assistant"
    data-testid="assistant-panel"
    style="--assistant-panel-w: {assistant.width}px"
    class="fixed inset-0 z-50 flex min-h-0 flex-col bg-background md:relative md:inset-auto md:z-auto md:w-[var(--assistant-panel-w)] md:shrink-0 md:border-l md:border-border"
  >
    <!-- The resize edge (desktop only): a focusable window splitter (WAI-ARIA), so the
         keyboard can resize too. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the assistant"
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={assistant.width}
      tabindex="0"
      data-testid="assistant-resize"
      class="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-px after:bg-transparent hover:after:bg-primary/40 focus-visible:after:bg-primary md:block"
      onpointerdown={onPointerDown}
      onkeydown={onEdgeKeydown}
    ></div>

    <header
      class="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2 pt-[env(safe-area-inset-top)]"
    >
      <div
        class="flex min-w-0 flex-1 items-center gap-0.5"
        role="tablist"
        aria-label="Assistant sections"
      >
        {#each tabs as tab, i (tab.id)}
          {@const selected = assistant.tab === tab.id}
          <button
            type="button"
            role="tab"
            id="assistant-tab-{tab.id}"
            aria-selected={selected}
            aria-controls="assistant-tabpanel"
            tabindex={selected ? 0 : -1}
            data-testid="assistant-tab-{tab.id}"
            onclick={() => assistant.selectTab(tab.id)}
            onkeydown={(e) => onTabKeydown(e, i)}
            class="h-7 rounded-md px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60
              {selected
              ? 'bg-primary/[0.08] font-medium text-foreground'
              : 'text-foreground/60 hover:bg-primary/[0.05] hover:text-foreground'}"
          >
            {tab.label}
          </button>
        {/each}
      </div>
      <button
        type="button"
        class="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground/70 outline-none hover:bg-primary/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        onclick={() => assistant.newConversation()}
        data-testid="assistant-new-conversation"
        title="New conversation"
      >
        <SquarePen class="size-4" aria-hidden="true" strokeWidth={1.75} />
        <span class="hidden lg:inline">New conversation</span>
        <span class="sr-only lg:hidden">New conversation</span>
      </button>
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/60 outline-none hover:bg-primary/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-label="Close the assistant"
        onclick={() => assistant.close()}
        data-testid="assistant-close"
      >
        <X class="size-4" aria-hidden="true" strokeWidth={1.75} />
      </button>
    </header>

    <div
      id="assistant-tabpanel"
      role="tabpanel"
      aria-labelledby="assistant-tab-{assistant.tab}"
      class="flex min-h-0 flex-1 flex-col"
    >
      {#if assistant.tab === 'chat'}
        <AssistantChatView {assistant} {language} />
      {:else if assistant.tab === 'history'}
        <AssistantHistory {assistant} />
      {:else}
        <AssistantActivity {assistant} />
      {/if}
    </div>
  </aside>
{/if}
