<script lang="ts">
  import { page } from '$app/state'
  import ErrorPanel from '$lib/components/error-panel.svelte'
</script>

<!-- Inside the shell group: the (nucleus) layout wraps this in the shell for signed-in users. -->
<ErrorPanel status={page.status} message={page.error?.message} signedIn={!!page.data.user} pluginOff={page.error?.pluginOff ?? null} />
