<script lang="ts">
  import type { Snippet } from 'svelte'
  import CircleHelpIcon from '@lucide/svelte/icons/circle-question-mark'
  import { Popover as PopoverPrimitive } from 'bits-ui'

  /**
   * Page info on demand (Contribute 19fc700d, b732961f): a small, always
   * present "?" button — usually next to a page title — that opens the page's
   * explanation in a popover. Nothing to dismiss: the text is hidden until
   * asked for and one click away again. bits-ui closes it on Escape and
   * outside click and returns focus to the button; `label` names both the
   * button and the panel.
   *
   * bits-ui puts the content's id on its floating wrapper and leaves the
   * trigger's aria-controls unset, so this renders both elements itself
   * (`child` snippets) and wires aria-controls to the dialog's own id.
   */
  let {
    label,
    children,
    testid,
    align = 'start',
  }: {
    label: string
    children: Snippet
    testid?: string
    align?: 'start' | 'center' | 'end'
  } = $props()

  const uid = $props.id()
  const contentId = `info-popover-${uid}`
  let open = $state(false)
</script>

<PopoverPrimitive.Root bind:open>
  <PopoverPrimitive.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        aria-label={label}
        aria-controls={open ? contentId : undefined}
        title={label}
        data-testid={testid}
        class="inline-grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-hidden hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground"
      >
        <CircleHelpIcon class="size-4" aria-hidden="true" strokeWidth={1.75} />
      </button>
    {/snippet}
  </PopoverPrimitive.Trigger>
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content {align} sideOffset={6} collisionPadding={16}>
      {#snippet child({ wrapperProps, props, open: shown })}
        {#if shown}
          <div {...wrapperProps}>
            <div
              {...props}
              id={contentId}
              role="dialog"
              aria-label={label}
              data-testid={testid ? `${testid}-content` : undefined}
              class="z-50 flex max-h-[min(32rem,var(--bits-popover-content-available-height))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-y-auto gap-2 rounded-xl bg-popover p-4 text-sm leading-relaxed text-muted-foreground shadow-md ring-1 ring-foreground/10 [&_a]:font-medium [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-medium [&_strong]:text-foreground"
            >
              {@render children()}
            </div>
          </div>
        {/if}
      {/snippet}
    </PopoverPrimitive.Content>
  </PopoverPrimitive.Portal>
</PopoverPrimitive.Root>
