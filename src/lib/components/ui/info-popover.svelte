<script lang="ts">
  import type { Snippet } from 'svelte'
  import CircleQuestionMark from '@lucide/svelte/icons/circle-question-mark'
  import * as Popover from '$lib/components/ui/popover'

  /**
   * A small "?" button that opens a popover with explanatory text — in place of
   * an always-visible info box (Contribute 09c6fc11: people dislike permanent
   * info text). `label` names the button for screen readers and heads the
   * popover; `children` is the text. The popover (bits-ui) moves focus in on
   * open, closes on Esc or a click outside and gives focus back to the button.
   */
  let {
    label,
    children,
    align = 'start',
    testid,
  }: {
    /** The question the popover answers ("Who can see your contacts?"). */
    label: string
    children: Snippet
    align?: 'start' | 'center' | 'end'
    testid?: string
  } = $props()
</script>

<Popover.Root>
  <Popover.Trigger
    class="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-hidden hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground"
    aria-label={label}
    data-testid={testid ? `${testid}-trigger` : undefined}
  >
    <CircleQuestionMark class="size-4" aria-hidden="true" strokeWidth={1.75} />
  </Popover.Trigger>
  <Popover.Content
    {align}
    side="bottom"
    sideOffset={6}
    class="w-[min(26rem,calc(100vw-1.5rem))] gap-2 p-4 text-sm"
    aria-label={label}
    data-testid={testid ? `${testid}-panel` : undefined}
  >
    <p class="font-medium">{label}</p>
    <div class="text-muted-foreground">{@render children()}</div>
  </Popover.Content>
</Popover.Root>
