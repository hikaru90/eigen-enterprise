<script lang="ts">
  import type { ChartPlacement } from './chart-anchor'
  import type { ChartKind, Grouping, LegendPos } from './chart-read'
  import type { SeriesDef } from './chart-write'
  import type { SheetOp } from './ops'
  import type { Workbook } from './workbook'
  import MinusIcon from '@lucide/svelte/icons/minus'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { m } from '$lib/paraglide/messages.js'
  import DictationField from '$lib/voice/dictation-field.svelte'
  import { themeOf } from './chart-color'
  import { CHART_KINDS, readChart } from './chart-read'
  import { hasAxes } from './chart-write'

  /**
   * Insert / Edit Chart dialog: creates a chart from the selection (type,
   * grouping, range, title, legend, optional chart sheet) or edits an existing
   * chart's type, grouping, title, legend, series ranges & types, axis titles
   * & scale, data labels, markers, and colours.
   */
  let {
    mode,
    sheet,
    wb,
    initialRange,
    placement,
    onsubmit,
    ondelete,
    onclose,
  }: {
    mode: 'create' | 'edit'
    sheet: string
    wb: Workbook
    initialRange: string
    placement: ChartPlacement | null
    /** Applies the operation; returns null on success or an error message to show inline. */
    onsubmit: (op: SheetOp) => Promise<string | null>
    ondelete?: () => void
    onclose: () => void
  } = $props()

  type EditableSeries = {
    id: number
    nameKind: 'ref' | 'text'
    name: string
    values: string
    categories: string
    sizes: string
    type: ChartKind
    secondary: boolean
    color: string | null
  }

  const initialModel = untrack(() =>
    mode === 'edit' && placement ? readChart(wb.pkg.xml(placement.part), themeOf(wb)) : null,
  )
  const initialFirstKind: ChartKind = initialModel?.plots[0]?.kind ?? 'column'
  const initialGrouping: Grouping = initialModel?.plots[0]?.grouping ?? 'clustered'
  const initialPrimaryCat =
    initialModel?.axes.find((a) => {
      const firstPlot = initialModel.plots.find((p) => p.axIds.includes(a.id))
      return (
        !a.deleted &&
        !firstPlot?.secondary &&
        (a.kind === 'cat' || (a.kind === 'val' && (a.pos === 'b' || a.pos === 't')))
      )
    }) ?? null
  const initialPrimaryVal =
    initialModel?.axes.find((a) => {
      const firstPlot = initialModel.plots.find((p) => p.axIds.includes(a.id))
      return !a.deleted && !firstPlot?.secondary && a.kind === 'val' && a !== initialPrimaryCat
    }) ?? null
  const initialSecondaryVal =
    initialModel?.axes.find((a) => {
      const secPlot = initialModel.plots.find((p) => p.secondary && p.axIds.includes(a.id))
      return !a.deleted && !!secPlot && a.kind === 'val'
    }) ?? null
  const initialLabel =
    initialModel?.plots
      .map((p) => p.labels ?? p.series.find((s) => s.labels)?.labels ?? null)
      .find((l) => l !== null) ?? null

  let nextSeriesId = 1
  const initialSeriesList: EditableSeries[] = initialModel
    ? initialModel.plots.flatMap((p) =>
        p.series.map((s) => ({
          id: nextSeriesId++,
          nameKind: (s.name.formula ? 'ref' : 'text') as 'ref' | 'text',
          name: s.name.formula ?? s.name.text ?? '',
          values: s.val?.formula ?? '',
          categories: s.cat?.formula ?? '',
          sizes: s.size?.formula ?? '',
          type: p.kind,
          secondary: p.secondary,
          color: s.color ?? (s.lineColor && s.lineColor !== 'none' ? s.lineColor : null),
        })),
      )
    : []

  const initialSeriesSnapshot = JSON.stringify(
    initialSeriesList.map(({ id: _id, color: _color, ...rest }) => rest),
  )

  let chartType = $state<ChartKind>(initialFirstKind)
  let grouping = $state<Grouping>(initialGrouping)
  let rangeText = $state(untrack(() => initialRange))
  let title = $state(initialModel?.title ?? '')
  let legend = $state<LegendPos | 'none'>(initialModel ? (initialModel.legend?.pos ?? 'none') : 'b')
  let placeOnNewSheet = $state(false)
  let newSheetName = $state('')

  let series = $state<EditableSeries[]>(initialSeriesList)
  let markers = $state(
    initialModel
      ? initialModel.plots.some((p) =>
          p.series.some((s) => s.marker !== null && s.marker.symbol !== 'none'),
        )
      : false,
  )
  let catTitle = $state(initialPrimaryCat?.title ?? '')
  let valTitle = $state(initialPrimaryVal?.title ?? '')
  let valMin = $state(
    initialPrimaryVal?.min !== null && initialPrimaryVal?.min !== undefined
      ? String(initialPrimaryVal.min)
      : '',
  )
  let valMax = $state(
    initialPrimaryVal?.max !== null && initialPrimaryVal?.max !== undefined
      ? String(initialPrimaryVal.max)
      : '',
  )
  let valGridlines = $state(initialPrimaryVal?.majorGridlines ?? true)
  let secTitle = $state(initialSecondaryVal?.title ?? '')
  let labelValue = $state(initialLabel?.value ?? false)
  let labelCategory = $state(initialLabel?.category ?? false)
  let labelSeries = $state(initialLabel?.series ?? false)
  let labelPercent = $state(initialLabel?.percent ?? false)

  let error = $state<string | null>(null)
  let busy = $state(false)

  const hasUnsupported = (initialModel?.unsupported.length ?? 0) > 0
  const showGrouping = $derived(
    chartType === 'column' || chartType === 'bar' || chartType === 'line' || chartType === 'area',
  )
  const showAxes = $derived(hasAxes(chartType))
  const hasSecondarySeries = $derived(showAxes && series.some((s) => s.secondary))
  const hasMarkerSeries = $derived(
    chartType === 'line' ||
      chartType === 'scatter' ||
      chartType === 'radar' ||
      series.some((s) => s.type === 'line' || s.type === 'scatter' || s.type === 'radar'),
  )

  const typeLabel = (k: ChartKind): string =>
    ({
      column: m.drive_sheet_chart_type_column(),
      bar: m.drive_sheet_chart_type_bar(),
      line: m.drive_sheet_chart_type_line(),
      area: m.drive_sheet_chart_type_area(),
      pie: m.drive_sheet_chart_type_pie(),
      doughnut: m.drive_sheet_chart_type_doughnut(),
      scatter: m.drive_sheet_chart_type_scatter(),
      bubble: m.drive_sheet_chart_type_bubble(),
      radar: m.drive_sheet_chart_type_radar(),
      stock: m.drive_sheet_chart_type_stock(),
    })[k]

  const groupingOptions = $derived(
    chartType === 'line' || chartType === 'area'
      ? ([
          { v: 'standard', label: m.drive_sheet_chart_grouping_standard() },
          { v: 'stacked', label: m.drive_sheet_chart_grouping_stacked() },
          { v: 'percentStacked', label: m.drive_sheet_chart_grouping_percent() },
        ] as const)
      : ([
          { v: 'clustered', label: m.drive_sheet_chart_grouping_clustered() },
          { v: 'stacked', label: m.drive_sheet_chart_grouping_stacked() },
          { v: 'percentStacked', label: m.drive_sheet_chart_grouping_percent() },
        ] as const),
  )

  function onTypeChange(next: ChartKind) {
    const prev = chartType
    chartType = next
    if ((next === 'line' || next === 'area') && grouping === 'clustered') grouping = 'standard'
    else if ((next === 'column' || next === 'bar') && grouping === 'standard')
      grouping = 'clustered'
    if (mode === 'edit') {
      // Keep per-series types aligned with chart type unless the user diverged them for a combo.
      series = series.map((s) => ({
        ...s,
        type: s.type === prev ? next : s.type,
        secondary: hasAxes(next) ? s.secondary : false,
      }))
    }
  }

  function addSeries() {
    const last = series.at(-1)
    series = [
      ...series,
      {
        id: nextSeriesId++,
        nameKind: 'text',
        name: m.drive_sheet_chart_series_n({ n: series.length + 1 }),
        values: last?.values ?? '',
        categories: last?.categories ?? '',
        sizes: '',
        type: chartType,
        secondary: false,
        color: null,
      },
    ]
  }

  function removeSeries(id: number) {
    if (series.length <= 1) return
    series = series.filter((s) => s.id !== id)
  }

  function parseOptionalNumber(text: string): number | null {
    const t = text.trim().replace(',', '.')
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : Number.NaN
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    error = null
    if (mode === 'create') {
      const op: SheetOp = {
        op: 'chart_create',
        sheet,
        type: chartType,
        ...(showGrouping ? { grouping } : {}),
        range: rangeText.trim(),
        ...(title.trim() !== '' ? { title: title.trim() } : {}),
        legend: legend === 'none' ? null : legend,
        ...(placeOnNewSheet ? { newSheet: newSheetName.trim() } : {}),
      }
      busy = true
      try {
        const msg = await onsubmit(op)
        if (msg) error = msg
        else onclose()
      } finally {
        busy = false
      }
      return
    }
    if (!placement) return
    const minVal = parseOptionalNumber(valMin)
    const maxVal = parseOptionalNumber(valMax)
    if (Number.isNaN(minVal) || Number.isNaN(maxVal)) {
      error = 'Axis min/max must be numbers.'
      return
    }
    const currentSnapshot = JSON.stringify(
      series.map(({ id: _id, color: _color, ...rest }) => rest),
    )
    const typeChanged = chartType !== initialFirstKind
    const groupingChanged = showGrouping && grouping !== initialGrouping
    const seriesChanged = currentSnapshot !== initialSeriesSnapshot
    const defs: SeriesDef[] = series.map((s) => ({
      values: s.values.trim(),
      categories: s.categories.trim() || null,
      sizes: s.type === 'bubble' ? s.sizes.trim() || null : null,
      name: s.name.trim()
        ? s.nameKind === 'ref'
          ? { ref: s.name.trim() }
          : { text: s.name.trim() }
        : null,
      ...(s.type !== chartType ? { type: s.type } : {}),
      ...(s.secondary ? { secondary: true } : {}),
    }))
    const hasLabels = labelValue || labelCategory || labelSeries || labelPercent
    const op: SheetOp = {
      op: 'chart_update',
      sheet: placement.sheet,
      chart: placement.id,
      ...(!hasUnsupported && (typeChanged || groupingChanged || seriesChanged)
        ? {
            type: chartType,
            ...(showGrouping ? { grouping } : {}),
            ...(seriesChanged ? { series: defs } : {}),
          }
        : {}),
      title: title.trim() || null,
      legend: legend === 'none' ? null : legend,
      ...(showAxes
        ? {
            axes: {
              category: { title: catTitle.trim() || null },
              value: {
                title: valTitle.trim() || null,
                min: minVal,
                max: maxVal,
                gridlines: valGridlines,
              },
              ...(hasSecondarySeries ? { secondary: { title: secTitle.trim() || null } } : {}),
            },
          }
        : {}),
      labels: hasLabels
        ? {
            value: labelValue,
            category: labelCategory,
            series: labelSeries,
            percent: labelPercent && (chartType === 'pie' || chartType === 'doughnut'),
          }
        : null,
      colors: series.map((s) => s.color),
      ...(hasMarkerSeries ? { markers } : {}),
    }
    busy = true
    try {
      const msg = await onsubmit(op)
      if (msg) error = msg
      else onclose()
    } finally {
      busy = false
    }
  }

  const field = 'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm'
  let titleEl = $state<HTMLInputElement | null>(null)
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) onclose()
  }}
>
  <Dialog.Content class="max-h-[88vh] max-w-xl overflow-y-auto" data-testid="xlsx-chart-dialog">
    <Dialog.Header>
      <Dialog.Title>
        {mode === 'create' ? m.drive_sheet_chart_create_title() : m.drive_sheet_chart_edit_title()}
      </Dialog.Title>
    </Dialog.Header>
    <form class="flex flex-col gap-3" onsubmit={submit}>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{m.drive_sheet_chart_type()}</span>
          <select
            class={field}
            value={chartType}
            disabled={hasUnsupported}
            onchange={(e) => onTypeChange(e.currentTarget.value as ChartKind)}
            data-testid="xlsx-chart-type"
          >
            {#each CHART_KINDS as k (k)}
              <option value={k}>{typeLabel(k)}</option>
            {/each}
          </select>
        </label>
        {#if showGrouping}
          <label class="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>{m.drive_sheet_chart_grouping()}</span>
            <select
              class={field}
              bind:value={grouping}
              disabled={hasUnsupported}
              data-testid="xlsx-chart-grouping"
            >
              {#each groupingOptions as g (g.v)}
                <option value={g.v}>{g.label}</option>
              {/each}
            </select>
          </label>
        {/if}
      </div>

      {#if mode === 'create'}
        <label class="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{m.drive_sheet_chart_range()}</span>
          <input
            type="text"
            class="{field} font-mono"
            bind:value={rangeText}
            required
            data-testid="xlsx-chart-range"
          />
        </label>
      {/if}

      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{m.drive_sheet_chart_title()}</span>
          <DictationField field={titleEl} kind="input" testid="xlsx-chart-title-voice">
            <input bind:this={titleEl} type="text" class={field} bind:value={title} data-testid="xlsx-chart-title" />
          </DictationField>
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{m.drive_sheet_chart_legend()}</span>
          <select class={field} bind:value={legend} data-testid="xlsx-chart-legend">
            <option value="none">{m.drive_sheet_chart_legend_none()}</option>
            <option value="r">{m.drive_sheet_chart_legend_r()}</option>
            <option value="b">{m.drive_sheet_chart_legend_b()}</option>
            <option value="t">{m.drive_sheet_chart_legend_t()}</option>
            <option value="l">{m.drive_sheet_chart_legend_l()}</option>
            <option value="tr">{m.drive_sheet_chart_legend_tr()}</option>
          </select>
        </label>
      </div>

      {#if mode === 'create'}
        <div class="flex flex-col gap-2">
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              class="accent-primary"
              bind:checked={placeOnNewSheet}
              data-testid="xlsx-chart-new-sheet-toggle"
            />
            {m.drive_sheet_chart_new_sheet()}
          </label>
          {#if placeOnNewSheet}
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>{m.drive_sheet_chart_new_sheet_name()}</span>
              <input
                type="text"
                class={field}
                bind:value={newSheetName}
                required
                data-testid="xlsx-chart-new-sheet"
              />
            </label>
          {/if}
        </div>
      {:else}
        <!-- Series editor -->
        <div class="flex flex-col gap-2 rounded-md border border-border p-2.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground"
              >{m.drive_sheet_chart_series()}</span
            >
            {#if !hasUnsupported}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onclick={addSeries}
                data-testid="xlsx-chart-add-series"
                ><PlusIcon class="size-3.5" aria-hidden="true" />
                {m.drive_sheet_chart_add_series()}</Button
              >
            {/if}
          </div>
          {#each series as s, i (s.id)}
            <div
              class="flex flex-col gap-2 rounded border border-border/60 bg-muted/20 p-2"
              data-testid="xlsx-chart-series-row"
            >
              <div class="flex items-center gap-2">
                <span class="text-xs font-medium text-muted-foreground"
                  >{m.drive_sheet_chart_series_n({ n: i + 1 })}</span
                >
                <label class="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="color"
                    class="h-6 w-8 cursor-pointer rounded border border-input bg-background p-0.5"
                    value={s.color ?? '#4472C4'}
                    aria-label={m.drive_sheet_chart_color()}
                    onchange={(e) => (s.color = e.currentTarget.value.toUpperCase())}
                    data-testid="xlsx-chart-series-color-{i}"
                  />
                  {#if s.color}
                    <button
                      type="button"
                      class="rounded px-1 text-xs underline hover:text-foreground"
                      onclick={() => (s.color = null)}>{m.drive_sheet_chart_color_auto()}</button
                    >
                  {/if}
                </label>
                {#if !hasUnsupported && series.length > 1}
                  <button
                    type="button"
                    class="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={m.drive_sheet_chart_remove_series()}
                    onclick={() => removeSeries(s.id)}
                    ><MinusIcon class="size-3.5" aria-hidden="true" /></button
                  >
                {/if}
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div class="flex gap-1">
                  <select
                    class="{field} w-20 shrink-0"
                    bind:value={s.nameKind}
                    disabled={hasUnsupported}
                    aria-label={m.drive_sheet_chart_name()}
                  >
                    <option value="ref">{m.drive_sheet_chart_name_ref()}</option>
                    <option value="text">{m.drive_sheet_chart_name_text()}</option>
                  </select>
                  <input
                    type="text"
                    class="{field} flex-1"
                    placeholder={m.drive_sheet_chart_name()}
                    bind:value={s.name}
                    disabled={hasUnsupported}
                    data-testid="xlsx-chart-series-name-{i}"
                  />
                </div>
                <input
                  type="text"
                  class="{field} font-mono"
                  placeholder={m.drive_sheet_chart_values()}
                  aria-label={m.drive_sheet_chart_values()}
                  bind:value={s.values}
                  disabled={hasUnsupported}
                  data-testid="xlsx-chart-series-values-{i}"
                />
                <input
                  type="text"
                  class="{field} font-mono"
                  placeholder={m.drive_sheet_chart_categories()}
                  aria-label={m.drive_sheet_chart_categories()}
                  bind:value={s.categories}
                  disabled={hasUnsupported}
                  data-testid="xlsx-chart-series-cats-{i}"
                />
                {#if s.type === 'bubble'}
                  <input
                    type="text"
                    class="{field} font-mono"
                    placeholder={m.drive_sheet_chart_sizes()}
                    aria-label={m.drive_sheet_chart_sizes()}
                    bind:value={s.sizes}
                    disabled={hasUnsupported}
                  />
                {:else if showAxes && !hasUnsupported}
                  <div class="flex items-center gap-2">
                    <select
                      class="{field} flex-1"
                      bind:value={s.type}
                      aria-label={m.drive_sheet_chart_type()}
                    >
                      {#each CHART_KINDS.filter((k) => hasAxes(k)) as k (k)}
                        <option value={k}>{typeLabel(k)}</option>
                      {/each}
                    </select>
                    <label class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <input type="checkbox" class="accent-primary" bind:checked={s.secondary} />
                      {m.drive_sheet_chart_secondary()}
                    </label>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>

        {#if showAxes}
          <div class="grid grid-cols-2 gap-2 rounded-md border border-border p-2.5">
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>{m.drive_sheet_chart_axis_cat()}</span>
              <input
                type="text"
                class={field}
                bind:value={catTitle}
                data-testid="xlsx-chart-axis-cat"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>{m.drive_sheet_chart_axis_val()}</span>
              <input
                type="text"
                class={field}
                bind:value={valTitle}
                data-testid="xlsx-chart-axis-val"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>{m.drive_sheet_chart_axis_min()}</span>
              <input type="text" class={field} bind:value={valMin} />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>{m.drive_sheet_chart_axis_max()}</span>
              <input type="text" class={field} bind:value={valMax} />
            </label>
            {#if hasSecondarySeries}
              <label class="col-span-2 flex flex-col gap-1 text-xs text-muted-foreground">
                <span>{m.drive_sheet_chart_axis_sec()}</span>
                <input type="text" class={field} bind:value={secTitle} />
              </label>
            {/if}
            <label class="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" class="accent-primary" bind:checked={valGridlines} />
              {m.drive_sheet_chart_axis_gridlines()}
            </label>
          </div>
        {/if}

        <!-- Data labels & markers -->
        <div
          class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border p-2.5 text-xs"
        >
          <span class="font-medium text-muted-foreground">{m.drive_sheet_chart_labels()}:</span>
          <label class="flex items-center gap-1.5">
            <input
              type="checkbox"
              class="accent-primary"
              bind:checked={labelValue}
              data-testid="xlsx-chart-label-val"
            />
            {m.drive_sheet_chart_label_value()}
          </label>
          <label class="flex items-center gap-1.5">
            <input type="checkbox" class="accent-primary" bind:checked={labelCategory} />
            {m.drive_sheet_chart_label_category()}
          </label>
          <label class="flex items-center gap-1.5">
            <input type="checkbox" class="accent-primary" bind:checked={labelSeries} />
            {m.drive_sheet_chart_label_series()}
          </label>
          {#if chartType === 'pie' || chartType === 'doughnut'}
            <label class="flex items-center gap-1.5">
              <input type="checkbox" class="accent-primary" bind:checked={labelPercent} />
              {m.drive_sheet_chart_label_percent()}
            </label>
          {/if}
          {#if hasMarkerSeries}
            <label class="ml-auto flex items-center gap-1.5">
              <input
                type="checkbox"
                class="accent-primary"
                bind:checked={markers}
                data-testid="xlsx-chart-markers"
              />
              {m.drive_sheet_chart_markers()}
            </label>
          {/if}
        </div>
      {/if}

      {#if error}
        <p class="text-xs text-destructive" role="alert" data-testid="xlsx-chart-error">{error}</p>
      {/if}

      <Dialog.Footer>
        {#if mode === 'edit' && ondelete && placement?.sheetKind !== 'chartsheet'}
          <Button
            type="button"
            variant="destructive"
            class="mr-auto"
            onclick={() => {
              onclose()
              ondelete()
            }}
            data-testid="xlsx-chart-dialog-delete">{m.drive_sheet_chart_delete()}</Button
          >
        {/if}
        <Button type="button" variant="outline" onclick={onclose}>{m.drive_sheet_cancel()}</Button>
        <Button type="submit" disabled={busy} data-testid="xlsx-chart-save"
          >{m.drive_sheet_chart_save()}</Button
        >
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
