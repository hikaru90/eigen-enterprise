<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- home is resolve('/') or the external website origin */
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import PublicSurface from './public-surface.svelte'
  import Wordmark from './wordmark.svelte'

  /**
   * The signed-out page frame (login, signup, claim, invite): the shell's
   * tokens and type, the wordmark, an h1 and an optional one-line subtitle.
   */
  let {
    title,
    subtitle,
    back = false,
    children,
  }: { title: string; subtitle?: string | null; back?: boolean; children: Snippet } = $props()

  const websiteOrigin = (import.meta.env.PUBLIC_WEBSITE_ORIGIN ?? '').replace(/\/$/, '')
  const home = websiteOrigin || resolve('/')
</script>

<PublicSurface>
  <div class="mx-auto w-full max-w-md px-4 pt-10 pb-16 sm:px-5">
    {#if back}
      <p class="mb-6">
        <a
          href={home}
          rel={websiteOrigin ? 'external' : undefined}
          class="chip chip-line text-muted-foreground hover:text-foreground"
          data-testid="back-home">← Back to home</a
        >
      </p>
    {/if}
    <header class="text-center">
      <Wordmark href={home} />
      <h1 class="display-l mt-8">{title}</h1>
      {#if subtitle}<p class="mt-2 text-sm text-muted-foreground">{subtitle}</p>{/if}
    </header>
    <div class="mt-8">
      {@render children()}
    </div>
  </div>
</PublicSurface>
