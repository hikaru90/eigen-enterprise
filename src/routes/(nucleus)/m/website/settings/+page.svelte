<script lang="ts">
  import type { PageProps } from './$types'
  import WebsiteSettings from '$lib/components/website-settings.svelte'
  import { docTitle } from '$lib/shell/title'
  let { data }: PageProps = $props()
</script>

<svelte:head><title>{docTitle('Settings', 'Website')}</title></svelte:head>

<WebsiteSettings {data} />
