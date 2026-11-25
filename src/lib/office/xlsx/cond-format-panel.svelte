<script lang="ts">
  import type { CfOp, CfRuleInput, CfRuleView, CfStyle } from './cond-format'
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down'
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up'
  import Trash2Icon from '@lucide/svelte/icons/trash-2'
  import XIcon from '@lucide/svelte/icons/x'
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { m } from '$lib/paraglide/messages.js'
  import {
    CF_OPERATORS,
    CF_TYPES,
    ICON_SET_NAMES,
    TIME_PERIODS,
    type CfOperator,
    type CfType,
    type IconSetName,
    type TimePeriod,
  } from './rules-choices'

  /**
   * Conditional formatting rules panel: lists the current sheet's rules in
   * priority order (edit, reorder, delete, clear) and adds/updates every
   * SpreadsheetML rule type. Calls the exact same CfOp operations as the tools.
   */
  let {
    sheet,
    selection,
    rules,
    onop,
    onclose,
  }: {
    sheet: string
    selection: string
    rules: CfRuleView[]
    onop: (op: CfOp) => Promise<string | null>
    onclose: () => void
  } = $props()

  let editingPriority = $state<number | null>(null)
  let range = $state(untrack(() => selection))
  let type = $state<CfType>('cellIs')
  let operator = $state<CfOperator>('greaterThan')
  let formula1 = $state('0')
  let formula2 = $state('100')
  let text = $state('')
  let period = $state<TimePeriod>('today')
  let rank = $state(10)
  let percent = $state(false)
  let bottom = $state(false)
  let below = $state(false)
  let equalAverage = $state(false)
  let stdDev = $state('')
  let stopIfTrue = $state(false)
  let useFill = $state(true)
  let fill = $state('#FFC7CE')
  let useFontColor = $state(true)
  let fontColor = $state('#9C0006')
  let bold = $state(false)
  let italic = $state(false)
  let underline = $state(false)
  let strike = $state(false)
  let scale3 = $state(false)
  let scaleMin = $state('#F8696B')
  let scaleMid = $state('#FFEB84')
  let scaleMax = $state('#63BE7B')
  let barColor = $state('#638EC6')
  let barNegColor = $state('#FF0000')
  let barGradient = $state(true)
  let barShowValue = $state(true)
  let iconSet = $state<IconSetName>('3TrafficLights1')
  let iconReverse = $state(false)
  let iconShowValue = $state(true)
  let error = $state<string | null>(null)

  const needsStyle = $derived(type !== 'colorScale' && type !== 'dataBar' && type !== 'iconSet')

  function resetForm() {
    editingPriority = null
    range = selection
    type = 'cellIs'
    operator = 'greaterThan'
    formula1 = '0'
    formula2 = '100'
    text = ''
    period = 'today'
    rank = 10
    percent = false
    bottom = false
    below = false
    equalAverage = false
    stdDev = ''
    stopIfTrue = false
    useFill = true
    fill = '#FFC7CE'
    useFontColor = true
    fontColor = '#9C0006'
    bold = false
    italic = false
    underline = false
    strike = false
    error = null
  }

  function loadRule(r: CfRuleView) {
    editingPriority = r.priority
    range = r.sqref
    type = r.type
    operator = r.operator ?? 'greaterThan'
    formula1 = r.formulas[0] ?? '0'
    formula2 = r.formulas[1] ?? '100'
    text = r.text ?? ''
    period = r.period ?? 'today'
    rank = r.rank ?? 10
    percent = r.percent
    bottom = r.bottom
    below = r.below
    equalAverage = r.equalAverage
    stdDev = r.stdDev ? String(r.stdDev) : ''
    stopIfTrue = r.stopIfTrue
    useFill = !!r.style?.fill
    fill = r.style?.fill ?? '#FFC7CE'
    useFontColor = !!r.style?.fontColor
    fontColor = r.style?.fontColor ?? '#9C0006'
    bold = !!r.style?.bold
    italic = !!r.style?.italic
    underline = !!r.style?.underline
    strike = !!r.style?.strike
    if (r.colorScale) {
      scale3 = r.colorScale.colors.length >= 3
      scaleMin = r.colorScale.colors[0] ?? '#F8696B'
      scaleMid = r.colorScale.colors[1] ?? '#FFEB84'
      scaleMax = r.colorScale.colors.at(-1) ?? '#63BE7B'
    }
    if (r.dataBar) {
      barColor = r.dataBar.color
      barNegColor = r.dataBar.negativeColor ?? '#FF0000'
      barGradient = r.dataBar.gradient
      barShowValue = r.dataBar.showValue
    }
    if (r.iconSet) {
      iconSet = r.iconSet.set
      iconReverse = r.iconSet.reverse
      iconShowValue = r.iconSet.showValue
    }
    error = null
  }

  function buildRule(): CfRuleInput {
    const style: CfStyle = {}
    if (useFill) style.fill = fill.toUpperCase()
    if (useFontColor) style.fontColor = fontColor.toUpperCase()
    if (bold) style.bold = true
    if (italic) style.italic = true
    if (underline) style.underline = true
    if (strike) style.strike = true
    const base = {
      type,
      ...(stopIfTrue ? { stopIfTrue: true } : {}),
      ...(needsStyle ? { style } : {}),
    }
    switch (type) {
      case 'cellIs':
        return {
          ...base,
          operator,
          formula1,
          ...(operator === 'between' || operator === 'notBetween' ? { formula2 } : {}),
        }
      case 'expression':
        return { ...base, formula1 }
      case 'containsText':
      case 'notContainsText':
      case 'beginsWith':
      case 'endsWith':
        return { ...base, text }
      case 'timePeriod':
        return { ...base, period }
      case 'top10':
        return { ...base, rank: Number(rank), percent, bottom }
      case 'aboveAverage':
        return {
          ...base,
          below,
          equalAverage,
          ...(stdDev ? { stdDev: Number(stdDev) } : {}),
        }
      case 'colorScale':
        return {
          type,
          points: scale3
            ? [
                { kind: 'min', color: scaleMin.toUpperCase() },
                { kind: 'percentile', value: '50', color: scaleMid.toUpperCase() },
                { kind: 'max', color: scaleMax.toUpperCase() },
              ]
            : [
                { kind: 'min', color: scaleMin.toUpperCase() },
                { kind: 'max', color: scaleMax.toUpperCase() },
              ],
        }
      case 'dataBar':
        return {
          type,
          bar: {
            color: barColor.toUpperCase(),
            negativeColor: barNegColor.toUpperCase(),
            gradient: barGradient,
            showValue: barShowValue,
            axis: 'automatic',
          },
        }
      case 'iconSet':
        return {
          type,
          icons: { set: iconSet, reverse: iconReverse, showValue: iconShowValue },
        }
      default:
        return base
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    error = null
    const rule = buildRule()
    const op: CfOp =
      editingPriority !== null
        ? { op: 'cf_update', sheet, priority: editingPriority, range, rule }
        : { op: 'cf_add', sheet, range, rule }
    const err = await onop(op)
    if (err) error = err
    else resetForm()
  }

  async function runAction(op: CfOp) {
    error = null
    const err = await onop(op)
    if (err) error = err
    else if (op.op === 'cf_delete' && op.priority === editingPriority) resetForm()
  }

  const typeLabel = (t: CfType): string =>
    ({
      cellIs: m.drive_sheet_cf_type_cellIs(),
      expression: m.drive_sheet_cf_type_expression(),
      colorScale: m.drive_sheet_cf_type_colorScale(),
      dataBar: m.drive_sheet_cf_type_dataBar(),
      iconSet: m.drive_sheet_cf_type_iconSet(),
      top10: m.drive_sheet_cf_type_top10(),
      aboveAverage: m.drive_sheet_cf_type_aboveAverage(),
      duplicateValues: m.drive_sheet_cf_type_duplicateValues(),
      uniqueValues: m.drive_sheet_cf_type_uniqueValues(),
      containsText: m.drive_sheet_cf_type_containsText(),
      notContainsText: m.drive_sheet_cf_type_notContainsText(),
      beginsWith: m.drive_sheet_cf_type_beginsWith(),
      endsWith: m.drive_sheet_cf_type_endsWith(),
      containsBlanks: m.drive_sheet_cf_type_containsBlanks(),
      notContainsBlanks: m.drive_sheet_cf_type_notContainsBlanks(),
      containsErrors: m.drive_sheet_cf_type_containsErrors(),
      notContainsErrors: m.drive_sheet_cf_type_notContainsErrors(),
      timePeriod: m.drive_sheet_cf_type_timePeriod(),
    })[t]

  const opLabel = (o: CfOperator): string =>
    ({
      between: m.drive_sheet_op_between(),
      notBetween: m.drive_sheet_op_notBetween(),
      equal: m.drive_sheet_op_equal(),
      notEqual: m.drive_sheet_op_notEqual(),
      greaterThan: m.drive_sheet_op_greaterThan(),
      lessThan: m.drive_sheet_op_lessThan(),
      greaterThanOrEqual: m.drive_sheet_op_greaterThanOrEqual(),
      lessThanOrEqual: m.drive_sheet_op_lessThanOrEqual(),
    })[o]

  const periodLabel = (p: TimePeriod): string =>
    ({
      today: m.drive_sheet_tp_today(),
      yesterday: m.drive_sheet_tp_yesterday(),
      tomorrow: m.drive_sheet_tp_tomorrow(),
      last7Days: m.drive_sheet_tp_last7Days(),
      thisWeek: m.drive_sheet_tp_thisWeek(),
      lastWeek: m.drive_sheet_tp_lastWeek(),
      nextWeek: m.drive_sheet_tp_nextWeek(),
      thisMonth: m.drive_sheet_tp_thisMonth(),
      lastMonth: m.drive_sheet_tp_lastMonth(),
      nextMonth: m.drive_sheet_tp_nextMonth(),
    })[p]

  function describe(r: CfRuleView): string {
    const base = typeLabel(r.type)
    if (r.type === 'cellIs' && r.operator) return `${opLabel(r.operator)} ${r.formulas.join(', ')}`
    if (r.type === 'expression') return r.formulas[0] ?? base
    if (r.text) return `${base}: “${r.text}”`
    if (r.period) return periodLabel(r.period)
    if (r.iconSet) return `${base}: ${r.iconSet.set}`
    return base
  }

  const field =
    'h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground'
</script>

<aside
  class="flex w-80 shrink-0 flex-col border-l bg-background text-sm"
  aria-label={m.drive_sheet_cf_title()}
  data-testid="xlsx-cf-panel"
>
  <div class="flex items-center justify-between border-b px-3 py-2">
    <h2 class="font-medium">{m.drive_sheet_cf_title()}</h2>
    <button
      type="button"
      class="inline-flex size-7 items-center justify-center rounded hover:bg-muted"
      aria-label={m.drive_sheet_cf_close()}
      onclick={onclose}
      data-testid="xlsx-cf-close"><XIcon class="size-4" aria-hidden="true" /></button
    >
  </div>

  <div class="flex-1 overflow-y-auto p-3">
    {#if error}
      <p
        class="mb-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        role="alert"
        data-testid="xlsx-cf-error"
      >
        {error}
      </p>
    {/if}

    {#if rules.length === 0}
      <p class="mb-3 text-xs text-muted-foreground" data-testid="xlsx-cf-empty">
        {m.drive_sheet_cf_empty()}
      </p>
    {:else}
      <ul class="mb-3 flex flex-col gap-1.5" data-testid="xlsx-cf-list">
        {#each rules as r (r.priority)}
          <li
            class="flex flex-col gap-1 rounded border border-border p-2 text-xs"
            data-testid="xlsx-cf-rule"
            data-priority={r.priority}
          >
            <div class="flex items-start justify-between gap-1">
              <div class="min-w-0 flex-1">
                <div class="font-medium truncate">#{r.priority} {describe(r)}</div>
                <div class="text-muted-foreground truncate">
                  {r.sqref}{r.stopIfTrue ? ` · ${m.drive_sheet_cf_stop()}` : ''}
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  class="rounded p-1 hover:bg-muted disabled:opacity-30"
                  disabled={r.priority <= 1}
                  aria-label={m.drive_sheet_cf_up()}
                  onclick={() =>
                    void runAction({
                      op: 'cf_move',
                      sheet,
                      priority: r.priority,
                      to: r.priority - 1,
                    })}
                  data-testid="xlsx-cf-up"
                  ><ArrowUpIcon class="size-3.5" aria-hidden="true" /></button
                >
                <button
                  type="button"
                  class="rounded p-1 hover:bg-muted disabled:opacity-30"
                  disabled={r.priority >= rules.length}
                  aria-label={m.drive_sheet_cf_down()}
                  onclick={() =>
                    void runAction({
                      op: 'cf_move',
                      sheet,
                      priority: r.priority,
                      to: r.priority + 1,
                    })}
                  data-testid="xlsx-cf-down"
                  ><ArrowDownIcon class="size-3.5" aria-hidden="true" /></button
                >
                <button
                  type="button"
                  class="rounded px-1.5 py-0.5 hover:bg-muted"
                  onclick={() => loadRule(r)}
                  data-testid="xlsx-cf-edit">{m.drive_sheet_cf_edit()}</button
                >
                <button
                  type="button"
                  class="rounded p-1 text-destructive hover:bg-destructive/10"
                  aria-label={m.drive_sheet_cf_delete()}
                  onclick={() => void runAction({ op: 'cf_delete', sheet, priority: r.priority })}
                  data-testid="xlsx-cf-delete"
                  ><Trash2Icon class="size-3.5" aria-hidden="true" /></button
                >
              </div>
            </div>
          </li>
        {/each}
      </ul>
      <div class="mb-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onclick={() => void runAction({ op: 'cf_clear', sheet, range: selection })}
          data-testid="xlsx-cf-clear-sel">{m.drive_sheet_cf_clear_sel()}</Button
        >
        <Button
          size="sm"
          variant="outline"
          onclick={() => void runAction({ op: 'cf_clear', sheet, range: null })}
          data-testid="xlsx-cf-clear-sheet">{m.drive_sheet_cf_clear_sheet()}</Button
        >
      </div>
    {/if}

    <form class="flex flex-col gap-2 border-t pt-3" onsubmit={submit}>
      <label class="flex flex-col gap-1 text-xs">
        <span class="text-muted-foreground">{m.drive_sheet_cf_range()}</span>
        <input class={field} bind:value={range} data-testid="xlsx-cf-range" />
      </label>

      <label class="flex flex-col gap-1 text-xs">
        <span class="text-muted-foreground">{m.drive_sheet_cf_type()}</span>
        <select class={field} bind:value={type} data-testid="xlsx-cf-type">
          {#each CF_TYPES as t (t)}<option value={t}>{typeLabel(t)}</option>{/each}
        </select>
      </label>

      {#if type === 'cellIs'}
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_cf_operator()}</span>
          <select class={field} bind:value={operator} data-testid="xlsx-cf-operator">
            {#each CF_OPERATORS as o (o)}<option value={o}>{opLabel(o)}</option>{/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_cf_val1()}</span>
          <input class={field} bind:value={formula1} data-testid="xlsx-cf-val1" />
        </label>
        {#if operator === 'between' || operator === 'notBetween'}
          <label class="flex flex-col gap-1 text-xs">
            <span class="text-muted-foreground">{m.drive_sheet_cf_val2()}</span>
            <input class={field} bind:value={formula2} data-testid="xlsx-cf-val2" />
          </label>
        {/if}
      {:else if type === 'expression'}
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_cf_val1()}</span>
          <input class={field} bind:value={formula1} data-testid="xlsx-cf-val1" />
        </label>
      {:else if type === 'containsText' || type === 'notContainsText' || type === 'beginsWith' || type === 'endsWith'}
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_cf_text()}</span>
          <input class={field} bind:value={text} data-testid="xlsx-cf-text" />
        </label>
      {:else if type === 'timePeriod'}
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_cf_period()}</span>
          <select class={field} bind:value={period} data-testid="xlsx-cf-period">
            {#each TIME_PERIODS as p (p)}<option value={p}>{periodLabel(p)}</option>{/each}
          </select>
        </label>
      {:else if type === 'top10'}
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_cf_rank()}</span>
          <input
            type="number"
            min="1"
            max="1000"
            class={field}
            bind:value={rank}
            data-testid="xlsx-cf-rank"
          />
        </label>
        <div class="flex gap-3 text-xs">
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={percent} /> {m.drive_sheet_cf_percent()}</label
          >
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={bottom} /> {m.drive_sheet_cf_bottom()}</label
          >
        </div>
      {:else if type === 'aboveAverage'}
        <div class="flex flex-wrap gap-3 text-xs">
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={below} /> {m.drive_sheet_cf_below()}</label
          >
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={equalAverage} />
            {m.drive_sheet_cf_equal_avg()}</label
          >
        </div>
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_cf_stddev()}</span>
          <select class={field} bind:value={stdDev}>
            <option value="">{m.drive_sheet_cf_stddev_none()}</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
      {:else if type === 'colorScale'}
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={scale3} data-testid="xlsx-cf-scale-3" />
          {m.drive_sheet_cf_scale_3()}
        </label>
        <div class="flex gap-2 text-xs">
          <label class="flex flex-col gap-1"
            ><span>{m.drive_sheet_cf_scale_min()}</span><input
              type="color"
              bind:value={scaleMin}
            /></label
          >
          {#if scale3}
            <label class="flex flex-col gap-1"
              ><span>{m.drive_sheet_cf_scale_mid()}</span><input
                type="color"
                bind:value={scaleMid}
              /></label
            >
          {/if}
          <label class="flex flex-col gap-1"
            ><span>{m.drive_sheet_cf_scale_max()}</span><input
              type="color"
              bind:value={scaleMax}
            /></label
          >
        </div>
      {:else if type === 'dataBar'}
        <div class="flex gap-3 text-xs">
          <label class="flex flex-col gap-1"
            ><span>{m.drive_sheet_cf_bar_color()}</span><input
              type="color"
              bind:value={barColor}
            /></label
          >
          <label class="flex flex-col gap-1"
            ><span>{m.drive_sheet_cf_bar_neg()}</span><input
              type="color"
              bind:value={barNegColor}
            /></label
          >
        </div>
        <div class="flex gap-3 text-xs">
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={barGradient} />
            {m.drive_sheet_cf_bar_gradient()}</label
          >
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={barShowValue} />
            {m.drive_sheet_cf_show_value()}</label
          >
        </div>
      {:else if type === 'iconSet'}
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_cf_icon_set()}</span>
          <select class={field} bind:value={iconSet} data-testid="xlsx-cf-icon-set">
            {#each ICON_SET_NAMES as s (s)}<option value={s}>{s}</option>{/each}
          </select>
        </label>
        <div class="flex gap-3 text-xs">
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={iconReverse} />
            {m.drive_sheet_cf_icon_reverse()}</label
          >
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={iconShowValue} />
            {m.drive_sheet_cf_show_value()}</label
          >
        </div>
      {/if}

      {#if needsStyle}
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={useFill} data-testid="xlsx-cf-fill-on" />
            {m.drive_sheet_cf_fill()}<input
              type="color"
              bind:value={fill}
              disabled={!useFill}
              data-testid="xlsx-cf-fill"
            /></label
          >
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={useFontColor} />
            {m.drive_sheet_cf_font_color()}<input
              type="color"
              bind:value={fontColor}
              disabled={!useFontColor}
              data-testid="xlsx-cf-font-color"
            /></label
          >
        </div>
        <div class="flex flex-wrap gap-2 text-xs">
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={bold} data-testid="xlsx-cf-bold" />
            {m.drive_sheet_cf_bold()}</label
          >
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={italic} /> {m.drive_sheet_cf_italic()}</label
          >
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={underline} />
            {m.drive_sheet_cf_underline()}</label
          >
          <label class="flex items-center gap-1"
            ><input type="checkbox" bind:checked={strike} /> {m.drive_sheet_cf_strike()}</label
          >
        </div>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={stopIfTrue} data-testid="xlsx-cf-stop" />
          {m.drive_sheet_cf_stop()}
        </label>
      {/if}

      <div class="flex items-center gap-2 pt-1">
        <Button type="submit" size="sm" data-testid="xlsx-cf-submit">
          {editingPriority !== null ? m.drive_sheet_cf_save() : m.drive_sheet_cf_add()}
        </Button>
        {#if editingPriority !== null}
          <Button type="button" size="sm" variant="outline" onclick={resetForm}
            >{m.drive_sheet_cancel()}</Button
          >
        {/if}
      </div>
    </form>
  </div>
</aside>
