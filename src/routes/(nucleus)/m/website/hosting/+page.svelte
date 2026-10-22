<script lang="ts">
  import type { PageProps } from './$types'
  import WebsiteSettings from '$lib/components/website-settings.svelte'
  let { data }: PageProps = $props()
</script>

<WebsiteSettings {data} />
