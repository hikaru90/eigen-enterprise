<script lang="ts">
  /** The call to action as the active style's primary button. */
  let { cta }: { cta: string } = $props()
</script>

<span
  class="inline-flex w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
  >{cta}</span
>
