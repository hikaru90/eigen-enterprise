<script lang="ts">
  import type { CallTile } from './call-state'
  import MicOff from '@lucide/svelte/icons/mic-off'
  import ScreenShare from '@lucide/svelte/icons/screen-share'
  import UserAvatar from '$lib/components/user-avatar.svelte'

  /**
   * One person (or one shared screen) in the call. Video is always muted:
   * sound plays through the room's own audio elements. The <video> gets the
   * participant's MediaStream on mount, so returning to the call page shows
   * the video again at once.
   */
  let {
    tile,
    emphasised = false,
    fit = 'cover',
    size = 'normal',
    class: className = '',
    style = '',
  }: {
    tile: CallTile
    /** The active speaker. */
    emphasised?: boolean
    fit?: 'cover' | 'contain'
    /** small: strip and self-view tiles (smaller label, small avatar). */
    size?: 'normal' | 'small'
    class?: string
    style?: string
  } = $props()

  function mediaStream(node: HTMLVideoElement, stream: MediaStream) {
    node.srcObject = stream
    return {
      update(next: MediaStream) {
        if (node.srcObject !== next) node.srcObject = next
      },
      destroy() {
        node.srcObject = null
      },
    }
  }
</script>

<div
  class={[
    'relative overflow-hidden rounded-xl bg-neutral-900 transition-shadow',
    tile.speaking ? 'ring-2 ring-emerald-400' : emphasised ? 'ring-2 ring-emerald-500/70' : 'ring-1 ring-white/10',
    className,
  ]}
  {style}
  data-testid="call-tile"
  data-identity={tile.identity}
  data-kind={tile.kind}
  data-local={tile.isLocal ? 'true' : 'false'}
  data-muted={tile.micOn ? 'false' : 'true'}
  data-video={tile.stream ? 'true' : 'false'}
  data-speaker={emphasised ? 'true' : 'false'}
>
  {#if tile.stream}
    <video
      use:mediaStream={tile.stream}
      autoplay
      playsinline
      muted
      class={['size-full', tile.kind === 'screen' || fit === 'contain' ? 'object-contain' : 'object-cover', tile.isLocal && tile.kind === 'camera' ? '-scale-x-100' : '']}
      data-testid="call-video"
    ></video>
  {:else}
    <div class="grid size-full place-items-center">
      <UserAvatar name={tile.name} size={size === 'small' ? 'md' : 'xl'} round class="bg-neutral-700! text-white!" />
    </div>
  {/if}
  <div
    class={[
      'absolute flex items-center gap-1 rounded-md bg-black/60 font-medium',
      size === 'small' ? 'bottom-1 left-1 max-w-[calc(100%-0.5rem)] px-1.5 py-0.5 text-xs' : 'bottom-2 left-2 max-w-[calc(100%-1rem)] px-2 py-1 text-xs',
    ]}
  >
    {#if tile.kind === 'camera' && !tile.micOn}<MicOff class="size-3.5 shrink-0 text-red-400" aria-label="Muted" data-testid="call-muted" />{/if}
    {#if tile.kind === 'screen'}<ScreenShare class="size-3.5 shrink-0" aria-hidden="true" />{/if}
    <span class="truncate" data-testid="call-tile-name">{tile.name}{tile.isLocal ? ' (you)' : ''}{tile.kind === 'screen' ? ' · screen' : ''}</span>
  </div>
</div>
