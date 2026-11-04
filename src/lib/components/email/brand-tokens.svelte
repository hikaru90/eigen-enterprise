<script lang="ts">
  import { resolve } from '$app/paths'

  /** The {{ brand.* }} tokens layouts and templates can use, with their current values. */
  let {
    brand,
  }: { brand: { source: 'visual_set' | 'app_default'; companyName: string | null; tokens: Record<string, string> } } = $props()
</script>

<section class="rounded-lg border border-border px-4 py-3 text-sm" data-testid="brand-tokens" data-source={brand.source}>
  <h3 class="font-medium">Your brand in email</h3>
  <p class="mt-1 text-muted-foreground">
    {#if brand.source === 'visual_set'}
      From your active brand style. Change it in <a class="underline underline-offset-4" href={resolve('/brand')}>Brand</a> and every layout follows.
    {:else}
      No brand style is active, so email uses the app's own style. Pick one in <a class="underline underline-offset-4" href={resolve('/brand')}>Brand</a>.
    {/if}
  </p>
  <dl class="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
    <div class="flex items-center justify-between gap-3">
      <dt><code class="font-mono text-xs">{'{{ brand.companyName }}'}</code></dt>
      <dd class="truncate text-xs text-muted-foreground">{brand.companyName ?? 'not named yet'}</dd>
    </div>
    {#each Object.entries(brand.tokens) as [k, v] (k)}
      <div class="flex items-center justify-between gap-3">
        <dt><code class="font-mono text-xs">{`{{ brand.${k} }}`}</code></dt>
        <dd class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {#if v.startsWith('#')}<span class="size-3 shrink-0 rounded-sm border border-border" style="background: {v}"></span>{/if}
          <span class="truncate">{v}</span>
        </dd>
      </div>
    {/each}
  </dl>
</section>
