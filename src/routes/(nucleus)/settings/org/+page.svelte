<script lang="ts">
  import type { PageProps } from './$types'
  import OrgChartTree from '$lib/coworkers/org-chart-tree.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { docTitle } from '$lib/shell/title'

  /** Settings → Org chart: who reports to whom, people and AI co-workers alike (plan/phase-ai-coworkers.md C5). */
  let { data, form }: PageProps = $props()
</script>

<svelte:head>
  <title>{docTitle(m.org_page_title(), 'Settings')}</title>
</svelte:head>

<div>
  <header class="mb-8">
    <h2 class="text-base font-semibold tracking-tight">{m.org_page_title()}</h2>
    <p class="mt-1 text-sm text-muted-foreground">
      {data.me.canManage ? m.org_page_intro_admin() : m.org_page_intro_member()}
    </p>
  </header>
  <OrgChartTree people={data.people} me={data.me} {form} />
</div>
