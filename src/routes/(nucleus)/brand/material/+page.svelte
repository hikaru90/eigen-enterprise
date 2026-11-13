<script lang="ts">
  import type { PageData } from './$types'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'
  import MaterialWorkbench from './material-workbench.svelte'

  /**
   * Brand material (Contribute idea): reusable pieces drawn from the active
   * style — digital flyer, banners, trade-show posters and merch.
   */
  let { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>{docTitle('Material', 'Brand')}</title>
</svelte:head>

<div class="mt-8 flex w-full flex-col gap-6">
  <header class="flex flex-col gap-1">
    <h2 class="text-base font-semibold tracking-tight">Brand material</h2>
    <p class="text-sm text-foreground/55">Reusable pieces in your company's style.</p>
  </header>

  {#if !data.style}
    <div
      class="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border px-6 py-16 text-center"
      data-testid="material-empty"
    >
      <h2 class="text-lg font-semibold">Choose a style first</h2>
      <p class="max-w-sm text-sm text-foreground/55">
        Brand material is drawn from your active style.
      </p>
      <Button href="/brand">Choose a style</Button>
    </div>
  {:else}
    <MaterialWorkbench style={data.style} />
  {/if}
</div>
