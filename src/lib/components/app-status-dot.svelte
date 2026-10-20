<script lang="ts">
  let { status }: { status: 'healthy' | 'deploying' | 'failed' } = $props()
  const label = $derived(
    status === 'healthy' ? 'Healthy' : status === 'deploying' ? 'Deploying' : 'Failed',
  )
  const color = $derived(
    status === 'healthy'
      ? 'bg-emerald-500'
      : status === 'deploying'
        ? 'bg-amber-400'
        : 'bg-red-500',
  )
</script>

<span class="inline-flex items-center gap-1.5 text-xs text-foreground/70">
  <span class={`size-2 rounded-full ${color}`} aria-hidden="true"></span>
  {label}
</span>
