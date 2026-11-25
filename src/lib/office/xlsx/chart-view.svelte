<script lang="ts">
  import type { Calc } from './calc'
  import type { ChartPlacement } from './chart-anchor'
  import type { SheetLocale } from './format'
  import type { Workbook } from './workbook'
  import { m } from '$lib/paraglide/messages.js'
  import { themeOf } from './chart-color'
  import { plotData, type SeriesData } from './chart-data'
  import { layoutChart } from './chart-layout'
  import { readChart } from './chart-read'

  /**
   * Renders one Excel chart (`c:chartSpace`) as inline SVG from the marks of
   * `layoutChart`, reading series values live from the workbook's cells (and
   * re-rendering whenever `rev` bumps).
   */
  let {
    wb,
    calc,
    placement,
    width,
    height,
    locale,
    rev,
  }: {
    wb: Workbook
    calc: () => Calc
    placement: ChartPlacement
    width: number
    height: number
    locale: SheetLocale
    rev: number
  } = $props()

  const rendered = $derived.by(() => {
    void rev
    if (!wb.pkg.has(placement.part)) return null
    const theme = themeOf(wb)
    const model = readChart(wb.pkg.xml(placement.part), theme)
    const c = calc()
    const data = model.plots.map((p) => plotData(wb, c, model, p, theme, locale))
    const scene = layoutChart(model, data, Math.max(40, width), Math.max(40, height), {
      locale,
      theme,
    })
    const byIdx: Record<number, SeriesData> = {}
    for (const grp of data) for (const s of grp) byIdx[s.idx] = s
    return { model, byIdx, scene }
  })

  function pointTooltip(series?: number, point?: number): string | null {
    if (!rendered || series === undefined || point === undefined) return null
    const s = rendered.byIdx[series]
    if (!s) return null
    const cat = s.categories[point] ?? String(point + 1)
    const val = s.values[point]
    return val === null || val === undefined ? `${s.name} (${cat})` : `${s.name} — ${cat}: ${val}`
  }
</script>

{#if rendered}
  {@const { model, scene } = rendered}
  <div class="cv-root relative h-full w-full overflow-hidden select-none">
    <svg
      class="cv-svg block h-full w-full"
      viewBox="0 0 {scene.width} {scene.height}"
      width={scene.width}
      height={scene.height}
      role="img"
      aria-label={model.title || placement.name}
      data-testid="xlsx-chart-svg"
      data-cached={scene.cached ? 'true' : undefined}
    >
      {#if scene.background}
        <rect x="0" y="0" width={scene.width} height={scene.height} fill={scene.background} />
      {/if}
      {#each scene.marks as mark, idx (idx)}
        {@const tip = pointTooltip(
          'series' in mark ? mark.series : undefined,
          'point' in mark ? mark.point : undefined,
        )}
        {#if mark.t === 'rect'}
          <rect
            x={mark.x}
            y={mark.y}
            width={mark.w}
            height={mark.h}
            fill={mark.fill}
            stroke={mark.stroke ?? 'none'}
            data-series={mark.series}
            data-point={mark.point}
            >{#if tip}<title>{tip}</title>{/if}</rect
          >
        {:else if mark.t === 'path'}
          <path
            d={mark.d}
            fill={mark.fill}
            stroke={mark.stroke}
            stroke-width={mark.width}
            stroke-dasharray={mark.dash ? '5 3' : undefined}
            data-series={mark.series}
            data-point={mark.point}
            >{#if tip}<title>{tip}</title>{/if}</path
          >
        {:else if mark.t === 'circle'}
          <circle
            cx={mark.cx}
            cy={mark.cy}
            r={mark.r}
            fill={mark.fill}
            stroke={mark.stroke}
            data-series={mark.series}
            data-point={mark.point}
            >{#if tip}<title>{tip}</title>{/if}</circle
          >
        {:else if mark.t === 'line'}
          <line
            x1={mark.x1}
            y1={mark.y1}
            x2={mark.x2}
            y2={mark.y2}
            stroke={mark.stroke}
            stroke-width={mark.width}
            data-role={mark.role}
          />
        {:else if mark.t === 'text'}
          <text
            x={mark.x}
            y={mark.y}
            text-anchor={mark.anchor}
            font-size={mark.size}
            font-weight={mark.weight}
            fill={mark.fill}
            transform={mark.rotate ? `rotate(${mark.rotate} ${mark.x} ${mark.y})` : undefined}
            data-role={mark.role}>{mark.text}</text
          >
        {/if}
      {/each}
    </svg>
    {#if scene.cached}
      <span
        class="cv-cached pointer-events-auto absolute top-1.5 left-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
        title={m.drive_sheet_chart_cached()}
        data-testid="xlsx-chart-cached">cached</span
      >
    {/if}
    {#if scene.unsupported.length > 0}
      <div
        class="cv-unsupported pointer-events-none absolute right-2 bottom-1.5 left-2 rounded bg-background/85 px-2 py-1 text-center text-xs text-muted-foreground"
        data-testid="xlsx-chart-unsupported"
      >
        {m.drive_sheet_chart_unsupported({ kinds: scene.unsupported.join(', ') })}
      </div>
    {/if}
  </div>
{/if}

<style>
  .cv-root {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    user-select: none;
  }

  .cv-svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  .cv-cached {
    position: absolute;
    top: 6px;
    left: 6px;
    pointer-events: auto;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 13px;
    font-weight: 500;
  }

  .cv-unsupported {
    position: absolute;
    right: 8px;
    bottom: 6px;
    left: 8px;
    pointer-events: none;
    border-radius: 4px;
    padding: 4px 8px;
    text-align: center;
    font-size: 13px;
  }
</style>
