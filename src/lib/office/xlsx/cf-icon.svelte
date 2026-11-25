<script lang="ts">
  import type { IconSetName } from './rules-choices'

  let { set, index }: { set: IconSetName; index: number } = $props()

  const COLOR_3 = ['#DC2626', '#CA8A04', '#16A34A']
  const COLOR_4 = ['#DC2626', '#EA580C', '#CA8A04', '#16A34A']
  const COLOR_5 = ['#DC2626', '#EA580C', '#CA8A04', '#65A30D', '#16A34A']

  const arrowColor = $derived.by(() => {
    if (set.includes('Gray')) return '#6B7280'
    if (set.startsWith('3')) return COLOR_3[index] ?? COLOR_3[0]!
    if (set.startsWith('4')) return COLOR_4[index] ?? COLOR_4[0]!
    return COLOR_5[index] ?? COLOR_5[0]!
  })

  const arrowDeg = $derived.by(() => {
    if (set.startsWith('3')) return index === 0 ? 180 : index === 1 ? 90 : 0
    if (set.startsWith('4')) return index === 0 ? 180 : index === 1 ? 135 : index === 2 ? 45 : 0
    return index === 0 ? 180 : index === 1 ? 135 : index === 2 ? 90 : index === 3 ? 45 : 0
  })

  const lightColor = $derived.by(() => {
    if (set === '4TrafficLights')
      return ['#1F2937', '#DC2626', '#CA8A04', '#16A34A'][index] ?? '#DC2626'
    if (set === '4RedToBlack')
      return ['#1F2937', '#6B7280', '#F87171', '#DC2626'][index] ?? '#1F2937'
    return COLOR_3[index] ?? COLOR_3[0]!
  })
</script>

<svg
  viewBox="0 0 12 12"
  width="12"
  height="12"
  class="shrink-0"
  data-testid="xlsx-cf-icon"
  data-set={set}
  data-index={index}
  aria-hidden="true"
>
  {#if set.includes('Arrows')}
    <g transform="rotate({arrowDeg} 6 6)">
      <path d="M6 1.5 L10 5.5 H7.4 V10.5 H4.6 V5.5 H2 Z" fill={arrowColor} />
    </g>
  {:else if set === '3Flags'}
    <rect x="2.2" y="1.5" width="1.2" height="9" fill="#4B5563" />
    <path d="M3.4 1.7 H10 L8.4 4.2 L10 6.7 H3.4 Z" fill={COLOR_3[index] ?? COLOR_3[0]} />
  {:else if set === '3Signs'}
    {#if index === 0}
      <polygon points="6,1.5 10.5,6 6,10.5 1.5,6" fill="#DC2626" />
    {:else if index === 1}
      <polygon points="6,1.5 10.5,10 1.5,10" fill="#CA8A04" />
    {:else}
      <circle cx="6" cy="6" r="4.3" fill="#16A34A" />
    {/if}
  {:else if set.startsWith('3Symbols')}
    <circle cx="6" cy="6" r="5" fill={COLOR_3[index] ?? COLOR_3[0]} />
    {#if index === 0}
      <path
        d="M3.8 3.8 L8.2 8.2 M8.2 3.8 L3.8 8.2"
        stroke="#FFFFFF"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    {:else if index === 1}
      <path
        d="M6 3.2 V6.6 M6 8.3 V8.9"
        stroke="#FFFFFF"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    {:else}
      <path
        d="M3.4 6.2 L5.3 8.1 L8.8 4.1"
        fill="none"
        stroke="#FFFFFF"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {/if}
  {:else if set === '3Stars'}
    <polygon
      points="6,1.2 7.4,4.2 10.7,4.6 8.3,6.9 8.9,10.2 6,8.6 3.1,10.2 3.7,6.9 1.3,4.6 4.6,4.2"
      fill={index === 0 ? 'none' : '#EAB308'}
      stroke="#CA8A04"
      stroke-width="1"
    />
    {#if index === 1}
      <rect x="6" y="1" width="5.5" height="10" fill="#FFFFFF" opacity="0.7" />
    {/if}
  {:else if set === '3Triangles'}
    {#if index === 0}
      <polygon points="2,3.5 10,3.5 6,9.5" fill="#DC2626" />
    {:else if index === 1}
      <rect x="2" y="4.8" width="8" height="2.4" rx="0.6" fill="#CA8A04" />
    {:else}
      <polygon points="6,2.5 10,8.5 2,8.5" fill="#16A34A" />
    {/if}
  {:else if set.endsWith('Rating')}
    {@const total = set.startsWith('4') ? 4 : 5}
    {#each Array.from({ length: total }, (_, i) => i) as bar (bar)}
      {@const h = 2.5 + bar * (total === 4 ? 2.2 : 1.7)}
      <rect
        x={1 + bar * (total === 4 ? 2.6 : 2.1)}
        y={10.8 - h}
        width={total === 4 ? 2 : 1.6}
        height={h}
        fill={bar <= index ? '#2563EB' : '#D1D5DB'}
      />
    {/each}
  {:else if set === '5Boxes'}
    {#each [0, 1, 2, 3] as b (b)}
      <rect
        x={b % 2 === 0 ? 2 : 6.5}
        y={b < 2 ? 2 : 6.5}
        width="3.5"
        height="3.5"
        fill={b < index ? '#2563EB' : '#E5E7EB'}
        stroke="#6B7280"
        stroke-width="0.6"
      />
    {/each}
  {:else if set === '5Quarters'}
    <circle cx="6" cy="6" r="4.5" fill="#E5E7EB" stroke="#4B5563" stroke-width="0.8" />
    {#if index >= 1}
      <path d="M6 6 L6 1.5 A4.5 4.5 0 0 1 10.5 6 Z" fill="#1F2937" />
    {/if}
    {#if index >= 2}
      <path d="M6 6 L10.5 6 A4.5 4.5 0 0 1 6 10.5 Z" fill="#1F2937" />
    {/if}
    {#if index >= 3}
      <path d="M6 6 L6 10.5 A4.5 4.5 0 0 1 1.5 6 Z" fill="#1F2937" />
    {/if}
    {#if index >= 4}
      <path d="M6 6 L1.5 6 A4.5 4.5 0 0 1 6 1.5 Z" fill="#1F2937" />
    {/if}
  {:else}
    <circle cx="6" cy="6" r="4.4" fill={lightColor} />
  {/if}
</svg>
