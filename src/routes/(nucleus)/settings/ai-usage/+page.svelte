<script lang="ts">
  import type { PageProps } from './$types'
  import AiUsageOverview from '$lib/components/settings/ai-usage-overview.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: PageProps = $props()
</script>

<svelte:head><title>{docTitle('AI usage', 'Settings')}</title></svelte:head>

<AiUsageOverview overview={data.overview} period={data.period} />
