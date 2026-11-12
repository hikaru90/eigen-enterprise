<script lang="ts">
  import type { Snippet } from 'svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'

  /** The Contacts area: one frame; each page brings its own header. */
  let { children }: { children: Snippet } = $props()
</script>

<PageFrame testid="contacts-area">
  {@render children()}
</PageFrame>
