<script lang="ts">
  import MemorySurfaceNav from '$lib/components/memory-surface-nav.svelte'

  let { children } = $props()
</script>

<MemorySurfaceNav />
{@render children()}
