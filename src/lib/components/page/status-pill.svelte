<script lang="ts">
  /** The one status pill: a dot plus a short label (Active / Not active / Connected …). "On" is the green success token. */
  let { label, on }: { label: string; on: boolean } = $props()
</script>

<!-- The website's status chip: mono, uppercase, a dot (the success token on, muted off). -->
<span
  class="chip chip-line shrink-0 text-xs {on ? 'text-foreground' : 'text-muted-foreground'}"
  data-testid="module-status"
>
  <span
    class="size-2 rounded-full {on ? 'bg-success' : 'bg-muted-foreground/40'}"
    aria-hidden="true"
  ></span>
  {label}
</span>
