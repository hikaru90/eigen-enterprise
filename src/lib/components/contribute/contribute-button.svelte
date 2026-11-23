<script lang="ts">
  import WandSparkles from '@lucide/svelte/icons/wand-sparkles'
  import { invalidate } from '$app/navigation'
  import { resolve } from '$app/paths'
  import * as Popover from '$lib/components/ui/popover'
  import { CONTRIBUTE_DEPENDENCY } from '$lib/contribute/board'
  import { contributeClient } from '$lib/contribute/client'
  import { m } from '$lib/paraglide/messages.js'
  import ContributeComposer from './contribute-composer.svelte'

  /**
   * The top bar's "Make a wish" button ("Wünsch dir was"; module `contribute`,
   * top right, every signed-in page): opens the composer where anyone in the company proposes an improvement
   * to the app. Proposals land on the board at /contribute, where an agent
   * picks them up.
   */
  let open = $state(false)
  /** The draft lives here, not in the composer: an outside click closes the popover and unmounts it. */
  let draft = $state('')
  const client = contributeClient()
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-card px-2.5 text-sm text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-primary data-[state=open]:text-primary-foreground sm:pr-3.5"
    aria-label={m.wish_trigger_label()}
    data-testid="contribute-trigger"
  >
    <WandSparkles class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" strokeWidth={1.75} />
    <span class="hidden sm:inline">{m.wish_name()}</span>
  </Popover.Trigger>
  <Popover.Content align="end" side="bottom" sideOffset={6} class="w-[min(24rem,calc(100vw-1.5rem))] p-4">
    <ContributeComposer
      {client}
      bind:text={draft}
      boardHref={resolve('/contribute')}
      onnavigate={() => (open = false)}
      onchanged={() => void invalidate(CONTRIBUTE_DEPENDENCY)}
    />
  </Popover.Content>
</Popover.Root>
