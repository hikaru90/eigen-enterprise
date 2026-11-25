<script lang="ts">
  import DictationField from '$lib/voice/dictation-field.svelte'
  import type { ValidationOp, ValidationRule, ValidationView } from './validation'
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { m } from '$lib/paraglide/messages.js'
  import {
    ERROR_STYLES,
    VALIDATION_OPERATORS,
    VALIDATION_TYPES,
    type ErrorStyle,
    type ValidationOperator,
    type ValidationType,
  } from './rules-choices'

  /**
   * Data Validation dialog: configures list, numeric, date, time, textLength
   * or custom formula rules, input prompts and stop/warning/information alerts.
   */
  let {
    sheet,
    range: rangeIn,
    current,
    onop,
    onclose,
  }: {
    sheet: string
    range: string
    current: ValidationView | null
    onop: (op: ValidationOp) => Promise<string | null>
    onclose: () => void
  } = $props()

  let range = $state(untrack(() => current?.sqref ?? rangeIn))
  let type = $state<ValidationType>(untrack(() => current?.type ?? 'list'))
  let operator = $state<ValidationOperator>(untrack(() => current?.operator ?? 'between'))
  let source = $state(
    untrack(() => (current?.items ? current.items.join(', ') : (current?.formula1 ?? ''))),
  )
  let formula2 = $state(untrack(() => current?.formula2 ?? ''))
  let allowBlank = $state(untrack(() => current?.allowBlank ?? true))
  let dropdown = $state(untrack(() => current?.dropdown ?? true))
  let showInput = $state(untrack(() => current?.showInput ?? true))
  let inputTitle = $state(untrack(() => current?.inputTitle ?? ''))
  let inputMessage = $state(untrack(() => current?.inputMessage ?? ''))
  let showError = $state(untrack(() => current?.showError ?? true))
  let errorStyle = $state<ErrorStyle>(untrack(() => current?.errorStyle ?? 'stop'))
  let errorTitle = $state(untrack(() => current?.errorTitle ?? ''))
  let errorMessage = $state(untrack(() => current?.errorMessage ?? ''))
  let error = $state<string | null>(null)

  const needsOperator = $derived(
    type === 'whole' ||
      type === 'decimal' ||
      type === 'date' ||
      type === 'time' ||
      type === 'textLength',
  )
  const needsSecond = $derived(
    needsOperator && (operator === 'between' || operator === 'notBetween'),
  )

  const typeLabel = (t: ValidationType) =>
    ({
      any: m.drive_sheet_dv_type_any(),
      whole: m.drive_sheet_dv_type_whole(),
      decimal: m.drive_sheet_dv_type_decimal(),
      list: m.drive_sheet_dv_type_list(),
      date: m.drive_sheet_dv_type_date(),
      time: m.drive_sheet_dv_type_time(),
      textLength: m.drive_sheet_dv_type_textLength(),
      custom: m.drive_sheet_dv_type_custom(),
    })[t]

  const opLabel = (o: ValidationOperator) =>
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

  const styleLabel = (s: ErrorStyle) =>
    ({
      stop: m.drive_sheet_dv_style_stop(),
      warning: m.drive_sheet_dv_style_warning(),
      information: m.drive_sheet_dv_style_information(),
    })[s]

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    error = null
    const rule: ValidationRule = {
      type,
      allowBlank,
      showInput,
      inputTitle: inputTitle.trim() || null,
      inputMessage: inputMessage.trim() || null,
      showError,
      errorStyle,
      errorTitle: errorTitle.trim() || null,
      errorMessage: errorMessage.trim() || null,
    }
    if (type === 'list') {
      rule.dropdown = dropdown
      const raw = source.trim()
      if (raw.startsWith('=')) rule.formula1 = raw
      else
        rule.items = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
    } else if (type === 'custom') {
      rule.formula1 = source
    } else if (needsOperator) {
      rule.operator = operator
      rule.formula1 = source
      if (needsSecond) rule.formula2 = formula2
    }
    const err = await onop({ op: 'validation_set', sheet, range, rule })
    if (err) error = err
    else onclose()
  }

  async function clear() {
    error = null
    const err = await onop({ op: 'validation_clear', sheet, range })
    if (err) error = err
    else onclose()
  }

  const field =
    'h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground'
  let inTitleEl = $state<HTMLInputElement | null>(null)
  let inMsgEl = $state<HTMLInputElement | null>(null)
  let errTitleEl = $state<HTMLInputElement | null>(null)
  let errMsgEl = $state<HTMLInputElement | null>(null)
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) onclose()
  }}
>
  <Dialog.Content class="max-w-lg" data-testid="xlsx-dv-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.drive_sheet_dv_title()}</Dialog.Title>
    </Dialog.Header>
    {#if error}
      <p
        class="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        role="alert"
        data-testid="xlsx-dv-error"
      >
        {error}
      </p>
    {/if}
    <form class="flex flex-col gap-3 text-sm" onsubmit={submit}>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_dv_range()}</span>
          <input class={field} bind:value={range} data-testid="xlsx-dv-range" />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_dv_allow()}</span>
          <select class={field} bind:value={type} data-testid="xlsx-dv-type">
            {#each VALIDATION_TYPES as t (t)}<option value={t}>{typeLabel(t)}</option>{/each}
          </select>
        </label>
      </div>

      {#if type === 'list'}
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_dv_source()}</span>
          <input
            class={field}
            bind:value={source}
            placeholder="Yes, No"
            data-testid="xlsx-dv-source"
          />
        </label>
        <div class="flex gap-4 text-xs">
          <label class="flex items-center gap-1.5"
            ><input type="checkbox" bind:checked={dropdown} data-testid="xlsx-dv-dropdown" />
            {m.drive_sheet_dv_dropdown()}</label
          >
          <label class="flex items-center gap-1.5"
            ><input type="checkbox" bind:checked={allowBlank} data-testid="xlsx-dv-blank" />
            {m.drive_sheet_dv_allow_blank()}</label
          >
        </div>
      {:else if needsOperator}
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_cf_operator()}</span>
          <select class={field} bind:value={operator} data-testid="xlsx-dv-operator">
            {#each VALIDATION_OPERATORS as o (o)}<option value={o}>{opLabel(o)}</option>{/each}
          </select>
        </label>
        <div class="grid {needsSecond ? 'grid-cols-2' : 'grid-cols-1'} gap-3">
          <label class="flex flex-col gap-1 text-xs">
            <span class="text-muted-foreground">{m.drive_sheet_cf_val1()}</span>
            <input class={field} bind:value={source} data-testid="xlsx-dv-val1" />
          </label>
          {#if needsSecond}
            <label class="flex flex-col gap-1 text-xs">
              <span class="text-muted-foreground">{m.drive_sheet_cf_val2()}</span>
              <input class={field} bind:value={formula2} data-testid="xlsx-dv-val2" />
            </label>
          {/if}
        </div>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={allowBlank} data-testid="xlsx-dv-blank" />
          {m.drive_sheet_dv_allow_blank()}
        </label>
      {:else if type === 'custom'}
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{m.drive_sheet_cf_val1()}</span>
          <input class={field} bind:value={source} placeholder="=A1>0" data-testid="xlsx-dv-val1" />
        </label>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={allowBlank} data-testid="xlsx-dv-blank" />
          {m.drive_sheet_dv_allow_blank()}
        </label>
      {/if}

      <div class="flex flex-col gap-2 rounded border border-border p-2.5 text-xs">
        <label class="flex items-center gap-1.5 font-medium">
          <input type="checkbox" bind:checked={showInput} data-testid="xlsx-dv-show-input" />
          {m.drive_sheet_dv_show_input()}
        </label>
        <div class="grid grid-cols-2 gap-2">
          <DictationField field={inTitleEl} kind="input" testid="xlsx-dv-input-title-voice">
            <input bind:this={inTitleEl}
            class={field}
            bind:value={inputTitle}
            placeholder={m.drive_sheet_dv_input_title()}
            disabled={!showInput}
            data-testid="xlsx-dv-input-title"
          />
          </DictationField>
          <DictationField field={inMsgEl} kind="input" testid="xlsx-dv-input-msg-voice">
            <input bind:this={inMsgEl}
            class={field}
            bind:value={inputMessage}
            placeholder={m.drive_sheet_dv_input_msg()}
            disabled={!showInput}
            data-testid="xlsx-dv-input-msg"
          />
          </DictationField>
        </div>
      </div>

      <div class="flex flex-col gap-2 rounded border border-border p-2.5 text-xs">
        <label class="flex items-center gap-1.5 font-medium">
          <input type="checkbox" bind:checked={showError} data-testid="xlsx-dv-show-error" />
          {m.drive_sheet_dv_show_error()}
        </label>
        <select
          class={field}
          bind:value={errorStyle}
          disabled={!showError}
          data-testid="xlsx-dv-error-style"
        >
          {#each ERROR_STYLES as s (s)}<option value={s}>{styleLabel(s)}</option>{/each}
        </select>
        <div class="grid grid-cols-2 gap-2">
          <DictationField field={errTitleEl} kind="input" testid="xlsx-dv-error-title-voice">
            <input bind:this={errTitleEl}
            class={field}
            bind:value={errorTitle}
            placeholder={m.drive_sheet_dv_error_title()}
            disabled={!showError}
            data-testid="xlsx-dv-error-title"
          />
          </DictationField>
          <DictationField field={errMsgEl} kind="input" testid="xlsx-dv-error-msg-voice">
            <input bind:this={errMsgEl}
            class={field}
            bind:value={errorMessage}
            placeholder={m.drive_sheet_dv_error_msg()}
            disabled={!showError}
            data-testid="xlsx-dv-error-msg"
          />
          </DictationField>
        </div>
      </div>

      <Dialog.Footer>
        <Button
          type="button"
          variant="ghost"
          class="mr-auto"
          onclick={() => void clear()}
          data-testid="xlsx-dv-clear"
        >
          {m.drive_sheet_dv_clear()}
        </Button>
        <Button type="button" variant="outline" onclick={onclose}>{m.drive_sheet_cancel()}</Button>
        <Button type="submit" data-testid="xlsx-dv-save">{m.drive_sheet_dv_save()}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
