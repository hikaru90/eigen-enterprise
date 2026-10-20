<script lang="ts">
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>Website</title>
</svelte:head>

<main class="mx-auto max-w-3xl px-5 py-10">
  <h1 class="mb-6 text-2xl font-light">Website</h1>
  {#if data.pages.length === 0}
    <p class="text-muted-foreground">No published pages yet.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.pages as page (page.slug)}
        <li>
          <a class="underline" href={`/s/${encodeURIComponent(page.slug)}`}>{page.title}</a>
          {#if page.draft}<span class="ml-2 text-sm text-muted-foreground">Draft — only you can see this</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</main>
