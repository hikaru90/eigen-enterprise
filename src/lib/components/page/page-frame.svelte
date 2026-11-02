<script lang="ts">
  import type { Snippet } from 'svelte'

  /**
   * The one content width rule (docs/design-system.md › Page frame):
   * - `default` — every area page: centred column, max-w-5xl. Forms and
   *   reading text inside cap themselves at max-w-2xl, left-aligned, so
   *   the left edge never moves between pages.
   * - `full` — only for card grids that gain from width (Brand styles,
   *   Website apps): the column fills the pane.
   */
  let {
    width = 'default',
    testid,
    children,
  }: { width?: 'default' | 'full'; testid?: string; children: Snippet } = $props()
</script>

<div
  class="w-full px-4 pt-6 pb-16 sm:px-8 sm:pt-10 {width === 'full' ? '' : 'mx-auto max-w-5xl'}"
  data-page-frame={width}
  data-testid={testid}
>
  {@render children()}
</div>
