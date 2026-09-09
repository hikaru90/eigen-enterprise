<script lang="ts">
  import type { PageData } from './$types'
  import WaterFlow from '../../../../modules/brand/water-flow.svelte'
  import { renderWebsiteMarkdown } from '../../../../modules/website/markdown'

  let { data }: { data: PageData } = $props()

  const bodyHtml = $derived(renderWebsiteMarkdown(data.body))
  const updatedOn = $derived(data.updatedAt.slice(0, 10))
</script>

<svelte:head>
  <title>{data.title}</title>
  <meta name="description" content={data.title} />
</svelte:head>

<article class="website-page">
  <div class="website-backdrop" aria-hidden="true"></div>
  <h1>{data.title}</h1>
  <header class="website-hero">
    <WaterFlow
      from="#060606"
      to="#b9b9b9"
      speed={0.8}
      scale={1.1}
      resolution={{ width: 40, height: 8 }}
    />
  </header>
  <div class="website-page-body">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- HTML from renderWebsiteMarkdown (sanitized) -->
    {@html bodyHtml}
  </div>
  <footer>
    <time datetime={data.updatedAt}>Updated {updatedOn}</time>
  </footer>
</article>

<style>
  .website-page {
    position: relative;
    z-index: 1;
    max-width: 56rem;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 4rem;
  }

  /* Full-viewport black behind the centered column; scoped + unmounts on nav
     (no :global body style leaks to console routes). Lives inside the z:1
     article so it paints above the root layout's bg-background wrapper. */
  .website-backdrop {
    position: fixed;
    inset: 0;
    background: #000;
  }

  .website-hero {
    position: relative;
    min-height: clamp(16rem, 42vh, 30rem);
    margin: 0 -1.25rem 1.75rem;
    overflow: hidden;
    background: transparent;
  }

  h1 {
    position: relative;
    font-family: 'MontserratThin', 'Inter', sans-serif;
    font-size: 1.75rem;
    font-weight: 300;
    line-height: 1.3;
    letter-spacing: 0.04em;
    color: #ffffff;
    margin: 0 0 1.5rem;
  }

  .website-page-body {
    line-height: 1.7;
    color: #c9c9c9;
  }

  .website-page-body :global(pre) {
    overflow-x: auto;
    padding: 0.75rem 1rem;
    border-radius: 0.375rem;
  }

  .website-page-body :global(code) {
    font-size: 0.9em;
  }

  .website-page footer {
    margin-top: 3rem;
    font-size: 0.85rem;
    color: #8a8a8a;
  }
</style>
