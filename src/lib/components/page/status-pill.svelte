<script lang="ts">
  /** The one status pill: a dot plus a short label (Active / Not active / Connected …). */
  let { label, on }: { label: string; on: boolean } = $props()
</script>

<span
  class="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium {on
    ? 'text-foreground'
    : 'text-muted-foreground'}"
  data-testid="module-status"
>
  <span
    class="size-1.5 rounded-full {on ? 'bg-primary' : 'bg-muted-foreground/40'}"
    aria-hidden="true"
  ></span>
  {label}
</span>
