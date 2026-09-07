<script lang="ts">
  import type { PageData } from './$types'
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
  <h1>{data.title}</h1>
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
    max-width: 44rem;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
  }

  .website-page h1 {
    font-size: 2rem;
    line-height: 1.2;
    margin-bottom: 1.5rem;
  }

  .website-page-body {
    line-height: 1.7;
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
    opacity: 0.65;
  }
</style>
