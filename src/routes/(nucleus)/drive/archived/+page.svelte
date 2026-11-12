<script lang="ts">
  import type { PageData } from './$types'
  import ArchivedView from '$lib/components/drive/archived-view.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>{docTitle('Archived', 'Drive')}</title></svelte:head>

<ArchivedView groups={data.groups} suggestDays={data.suggestDays} />
