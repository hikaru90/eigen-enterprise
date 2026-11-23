<script lang="ts">
  import type { PageProps } from './$types'
  import { invalidate } from '$app/navigation'
  import ContributeViews from '$lib/components/contribute/contribute-views.svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { CONTRIBUTE_DEPENDENCY } from '$lib/contribute/board'
  import { contributeClient } from '$lib/contribute/client'
  import { m } from '$lib/paraglide/messages.js'
  import { docTitle } from '$lib/shell/title'

  /** /contribute ("Make a wish"): what people wished for, voted on, and picked up by an agent. */
  let { data }: PageProps = $props()
  const client = contributeClient()
</script>

<svelte:head>
  <title>{docTitle(m.wish_name())}</title>
</svelte:head>

<PageFrame testid="contribute">
  <PageHeader
    title={m.wish_name()}
    part="contribute"
  >
    {#snippet info()}
      <p>{m.wish_page_info({ company: data.companyName ?? m.wish_page_your_company() })}</p>
    {/snippet}
  </PageHeader>
  <div class="mt-6">
    <ContributeViews
      proposals={data.proposals}
      hub={data.hub}
      canManage={data.canManage}
      sharing={data.sharing}
      {client}
      onchanged={() => invalidate(CONTRIBUTE_DEPENDENCY)}
    />
  </div>
</PageFrame>
