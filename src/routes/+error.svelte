<script lang="ts">
  import { page } from '$app/state'
  import ErrorPanel from '$lib/components/error-panel.svelte'
  import PublicSurface from '$lib/components/page/public-surface.svelte'
</script>

<!-- Errors outside the shell group (signed-out pages, a failing shell load):
     the same tokens and wordmark as the shell. -->
<PublicSurface>
  <ErrorPanel status={page.status} message={page.error?.message} signedIn={!!page.data.user} pluginOff={page.error?.pluginOff ?? null} />
</PublicSurface>
