<script lang="ts">
  import type { PageData } from './$types'
  import { page } from '$app/state'
  import { docTitle } from '$lib/shell/title'
  import SocialLibrary from './social-library.svelte'

  /** Brand › Social (Contribute 6ff283ef): social posts collected in the company's style. */
  let { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>{docTitle('Social', 'Brand')}</title>
</svelte:head>

<div class="mt-8 flex w-full flex-col gap-6">
  <header class="flex flex-col gap-1">
    <h2 class="text-base font-semibold tracking-tight">Social posts</h2>
    <p class="text-sm text-muted-foreground">Posts in your company's style, with captions for each network.</p>
  </header>
  <SocialLibrary
    posts={data.posts}
    style={data.style}
    activeLocales={data.activeLocales}
    assistantOn={page.data.shell?.assistant ?? false}
    selected={data.selected}
  />
</div>
