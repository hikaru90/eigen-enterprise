<script lang="ts">
  import Lightbulb from '@lucide/svelte/icons/lightbulb'
  import { invalidate } from '$app/navigation'
  import { resolve } from '$app/paths'
  import * as Popover from '$lib/components/ui/popover'
  import { CONTRIBUTE_DEPENDENCY } from '$lib/contribute/board'
  import { contributeClient } from '$lib/contribute/client'
  import ContributeComposer from './contribute-composer.svelte'

  /**
   * The top bar's "Contribute" button (top right, every signed-in page):
   * opens the composer where anyone in the company proposes an improvement
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
    class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground/70 outline-none hover:bg-primary/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-primary/[0.08] data-[state=open]:text-foreground"
    aria-label="Contribute: propose an improvement"
    data-testid="contribute-trigger"
  >
    <Lightbulb class="size-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
    <span class="hidden sm:inline">Contribute</span>
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
