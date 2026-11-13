<script lang="ts" module>
  /** The dialog panel's surface (colour, radius, border, padding, shadow) — shared with the static design-system preview. */
  export const dialogSurfaceClass =
    'bg-background grid w-full max-w-lg gap-4 squircle border-0 p-6 shadow-2xl'
</script>

<script lang="ts">
  import { Dialog as DialogPrimitive } from 'bits-ui'
  import { cn } from '$lib/utils.js'
  import DialogOverlay from './dialog-overlay.svelte'
  import DialogPortal from './dialog-portal.svelte'

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: DialogPrimitive.ContentProps = $props()
</script>

<DialogPortal>
  <DialogOverlay />
  <DialogPrimitive.Content
    bind:ref
    data-slot="dialog-content"
    class={cn(
      dialogSurfaceClass,
      'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 fixed left-1/2 top-1/2 z-[60] -translate-x-1/2 -translate-y-1/2 duration-200',
      className,
    )}
    {...restProps}
  >
    {@render children?.()}
  </DialogPrimitive.Content>
</DialogPortal>
