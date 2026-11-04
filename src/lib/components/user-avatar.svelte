<script lang="ts" module>
  export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

  /** Pixel sizes: xs 20 (inline), sm 24 (lists), md 36 (message rows), lg 48, xl 96 (profile). */
  export const AVATAR_PX: Record<AvatarSize, number> = { xs: 20, sm: 24, md: 36, lg: 48, xl: 96 }
</script>

<script lang="ts">
  import { initialsOf } from '$lib/profile/profile'

  /**
   * A person's picture (P-5), or their initials when they have none yet (or
   * the picture can't load). Rounded square like Slack; `round` for a circle.
   */
  let {
    name,
    image = null,
    size = 'md',
    round = false,
    class: className = '',
    testid = 'user-avatar',
  }: {
    name: string | null | undefined
    image?: string | null
    size?: AvatarSize
    round?: boolean
    class?: string
    testid?: string
  } = $props()

  /** The image URL that failed to load (initials until a different one arrives). */
  let failed = $state<string | null>(null)
  const px = $derived(AVATAR_PX[size])
  const showImage = $derived(Boolean(image) && failed !== image)
  const label = $derived(name?.trim() || 'Unknown person')
  const fontPx = $derived(Math.max(9, Math.round(px * 0.38)))
</script>

<span
  class={[
    'relative inline-grid shrink-0 place-items-center overflow-hidden bg-primary/12 font-semibold text-primary select-none',
    round ? 'rounded-full' : px >= 48 ? 'rounded-xl' : 'rounded-md',
    className,
  ]}
  style="width: {px}px; height: {px}px; font-size: {fontPx}px;"
  role="img"
  aria-label={label}
  data-testid={testid}
  data-has-image={showImage ? 'true' : 'false'}
>
  {#if showImage && image}
    <img
      src={image}
      alt=""
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      class="size-full object-cover"
      onerror={() => (failed = image)}
    />
  {:else}
    <span aria-hidden="true" class="leading-none">{initialsOf(name)}</span>
  {/if}
</span>
