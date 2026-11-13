<script lang="ts">
  import type { HubProposalDto } from '../../../../modules/contribute/hub/types'
  import type { ShareItemView } from '../../../../modules/contribute/share/service'
  import type { ContributionDto } from '../../../../modules/contribute/types'
  import type { ContributeClient } from '$lib/contribute/client'
  import ContributeBoard from './contribute-board.svelte'
  import ContributeHubBoard from './contribute-hub-board.svelte'

  /**
   * /contribute's views: the company's own board, and — only on the central
   * board's install (contribute-hub on) and only for the owner and admins —
   * "All installs". `hub` is null everywhere else, and then there are no tabs.
   */
  type Props = {
    proposals: ContributionDto[]
    canManage: boolean
    /** Each proposal's sharing with the central board, for the owner and admins; null otherwise. */
    sharing: Record<string, ShareItemView> | null
    client: Pick<ContributeClient, 'vote' | 'update' | 'sentPayload' | 'dontShare'>
    onchanged: () => Promise<void>
    hub: HubProposalDto[] | null
  }

  let { proposals, canManage, sharing, client, onchanged, hub }: Props = $props()

  type View = 'company' | 'hub'
  let view = $state<View>('company')
  const VIEWS: { id: View; label: string }[] = [
    { id: 'company', label: 'This company' },
    { id: 'hub', label: 'All installs' },
  ]
</script>

{#if hub === null}
  <ContributeBoard {proposals} {canManage} {sharing} {client} {onchanged} />
{:else}
  <div class="flex flex-col gap-4">
    <div class="flex gap-1" role="tablist" aria-label="Boards">
      {#each VIEWS as v (v.id)}
        <button
          type="button"
          role="tab"
          aria-selected={view === v.id}
          class="cursor-pointer rounded-md px-3 py-1.5 text-sm {view === v.id
            ? 'bg-primary/[0.08] font-medium text-foreground'
            : 'text-foreground/60 hover:text-foreground'}"
          onclick={() => (view = v.id)}
          data-testid="contribute-view-{v.id}"
        >
          {v.label}
        </button>
      {/each}
    </div>
    {#if view === 'company'}
      <ContributeBoard {proposals} {canManage} {sharing} {client} {onchanged} />
    {:else}
      <ContributeHubBoard proposals={hub} />
    {/if}
  </div>
{/if}
