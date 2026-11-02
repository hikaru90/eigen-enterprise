<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import PublicSurface from '$lib/components/page/public-surface.svelte'

  /** The public company site's index: for visitors, named after the company. */
  let { data }: { data: PageData } = $props()
  const siteName = $derived(data.companyName ?? 'Our website')
</script>

<svelte:head>
  <title>{data.companyName ? `${data.companyName} — Pages` : 'Pages'}</title>
</svelte:head>

<PublicSurface>
  <main class="mx-auto w-full max-w-3xl px-4 py-10 sm:px-5">
    <h1 class="text-2xl font-semibold tracking-tight">{siteName}</h1>
    <p class="mt-1 text-sm text-muted-foreground">Pages</p>
    {#if data.pages.length === 0}
      <p class="mt-6 text-muted-foreground">No published pages yet.</p>
    {:else}
      <ul class="mt-6 space-y-2">
        {#each data.pages as page (page.slug)}
          <li>
            <a class="underline underline-offset-4" href={resolve('/s/[slug]', { slug: page.slug })}
              >{page.title}</a
            >
            {#if page.draft}<span class="ml-2 text-sm text-muted-foreground"
                >Draft — only you can see this</span
              >{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </main>
</PublicSurface>
