<script lang="ts">
  import { page } from '$app/state'
  import ErrorPanel from '$lib/components/error-panel.svelte'
</script>

<!-- Errors outside the shell group (signed-out pages, a failing shell load). -->
<ErrorPanel status={page.status} message={page.error?.message} signedIn={!!page.data.user} />
