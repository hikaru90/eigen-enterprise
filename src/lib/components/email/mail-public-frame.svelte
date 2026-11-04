<script lang="ts">
  import type { Snippet } from 'svelte'
  import PublicSurface from '$lib/components/page/public-surface.svelte'

  /**
   * The pages a mail recipient opens (unsubscribe, confirm, sign up): the
   * company's brand tokens, no app chrome — the visitor is not a member.
   */
  let { title, children }: { title: string; children: Snippet } = $props()
</script>

<PublicSurface>
  <main class="mx-auto w-full max-w-md px-4 pt-16 pb-16 sm:px-5" data-testid="mail-public">
    <h1 class="text-xl font-semibold tracking-tight">{title}</h1>
    <div class="mt-4 text-sm">{@render children()}</div>
  </main>
</PublicSurface>
