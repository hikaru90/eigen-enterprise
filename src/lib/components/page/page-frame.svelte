<script lang="ts">
  import type { Snippet } from 'svelte'

  /**
   * The one content width rule (docs/design-system.md › Page frame, polish P-3):
   * every area page uses the full width of the pane (`px-4 sm:px-8`). Forms
   * and reading text inside cap themselves at max-w-2xl, left-aligned, so the
   * left edge never moves between pages.
   */
  let { testid, children }: { testid?: string; children: Snippet } = $props()
</script>

<div class="w-full min-w-0 px-4 pt-6 pb-16 sm:px-8 sm:pt-10" data-page-frame data-testid={testid}>
  {@render children()}
</div>
