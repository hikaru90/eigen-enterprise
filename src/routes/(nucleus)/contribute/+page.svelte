<script lang="ts">
  import type { PageProps } from './$types'
  import { invalidate } from '$app/navigation'
  import ContributeBoard from '$lib/components/contribute/contribute-board.svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { CONTRIBUTE_DEPENDENCY } from '$lib/contribute/board'
  import { contributeClient } from '$lib/contribute/client'
  import { docTitle } from '$lib/shell/title'

  /** /contribute: what people asked for, voted on, and picked up by an agent. */
  let { data }: PageProps = $props()
  const client = contributeClient()
</script>

<svelte:head>
  <title>{docTitle('Contribute')}</title>
</svelte:head>

<PageFrame testid="contribute">
  <PageHeader
    title="Contribute"
    description={`Ideas, bugs and polish requests from everyone at ${data.companyName ?? 'your company'}. Propose one with Contribute at the top right and vote for the ones you want most; an agent picks them up from here.`}
  />
  <div class="mt-6">
    <ContributeBoard
      proposals={data.proposals}
      canManage={data.canManage}
      sharing={data.sharing}
      {client}
      onchanged={() => invalidate(CONTRIBUTE_DEPENDENCY)}
    />
  </div>
</PageFrame>
