<script lang="ts">
  import { presenceLabel, type PresenceStatus, type PresenceView } from './presence'

  /**
   * A person's status as a small badge on an avatar's corner. Shape AND color
   * differ per status (a phone for a call, a bar for do-not-disturb, a clock
   * for away, a hollow ring for offline), and the words are its accessible
   * name and tooltip — never color alone.
   */
  let {
    presence,
    now,
    size = 10,
    class: className = '',
    testid = 'presence-dot',
  }: {
    presence: PresenceView
    now: Date
    /** Pixels (10 on list avatars, 12 on larger ones). */
    size?: number
    class?: string
    testid?: string
  } = $props()

  const GLYPH: Record<PresenceStatus, 'phone' | 'bar' | 'clock' | 'none' | 'ring'> = {
    in_call: 'phone',
    dnd: 'bar',
    away: 'clock',
    online: 'none',
    offline: 'ring',
  }
  const FILL: Record<PresenceStatus, string> = {
    in_call: 'bg-violet-600',
    dnd: 'bg-red-600',
    away: 'bg-amber-600',
    online: 'bg-emerald-600',
    offline: 'border-2 border-muted-foreground bg-background',
  }

  const label = $derived(presenceLabel(presence, now))
  const glyph = $derived(GLYPH[presence.status])
</script>

<span
  role="img"
  aria-label={label}
  title={label}
  data-testid={testid}
  data-status={presence.status}
  data-glyph={glyph}
  class={['inline-grid shrink-0 place-items-center rounded-full ring-2 ring-background', FILL[presence.status], className]}
  style="width: {size}px; height: {size}px;"
>
  {#if glyph === 'phone' || glyph === 'bar' || glyph === 'clock'}
    <svg viewBox="-4 -4 32 32" class="size-full text-white" aria-hidden="true">
      {#if glyph === 'phone'}
        <path
          fill="currentColor"
          d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"
        />
      {:else if glyph === 'bar'}
        <rect x="4" y="9.5" width="16" height="5" rx="2" fill="currentColor" />
      {:else}
        <path d="M12 5v7.5l4.5 3" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
      {/if}
    </svg>
  {/if}
</span>
