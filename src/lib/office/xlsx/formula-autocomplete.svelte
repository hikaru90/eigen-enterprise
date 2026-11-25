<script lang="ts">
  import type { ActiveFunctionCall } from './formula-edit'
  import { m } from '$lib/paraglide/messages.js'
  import { signatureText, type FunctionSig } from './function-catalog'

  /**
   * Formula bar assistant:
   * - Function autocomplete list (`matches`) when typing a function name after `=` or an operator
   * - Active function argument hint (`hint`) highlighting the current parameter as commas advance
   */
  let {
    matches,
    selectedIndex,
    hint,
    onpick,
  }: {
    matches: FunctionSig[]
    selectedIndex: number
    hint: ActiveFunctionCall | null
    onpick: (name: string) => void
  } = $props()
</script>

{#if matches.length > 0 || hint}
  <div class="pointer-events-auto absolute top-full left-0 z-40 mt-0.5 flex flex-col gap-1">
    {#if hint}
      <div
        class="max-w-xl rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
        role="status"
        aria-label={m.drive_sheet_formula_hint()}
        data-testid="xlsx-formula-hint"
      >
        <div class="font-mono">
          <span class="font-semibold text-foreground">{hint.sig.name}</span>(<span
            >{#each hint.sig.args as arg, i (arg.name + i)}{#if i > 0},
              {/if}<span
                class={i === hint.highlightIndex
                  ? 'rounded bg-primary/15 px-0.5 font-semibold text-primary'
                  : 'text-muted-foreground'}
                >{arg.optional ? `[${arg.name}]` : arg.name}{arg.repeat ? ', …' : ''}</span
              >{/each}</span
          >)
        </div>
      </div>
    {/if}
    {#if matches.length > 0}
      <ul
        class="max-h-56 w-80 overflow-y-auto rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg"
        role="listbox"
        aria-label={m.drive_sheet_formula_suggestions()}
        data-testid="xlsx-formula-autocomplete"
      >
        {#each matches as fn, idx (fn.name)}
          <li
            role="option"
            aria-selected={idx === selectedIndex}
            class="flex cursor-pointer flex-col rounded px-2 py-1 {idx === selectedIndex
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-accent/50'}"
            onmousedown={(e) => {
              e.preventDefault()
              onpick(fn.name)
            }}
          >
            <div class="flex items-baseline justify-between gap-2 font-mono">
              <span class="font-semibold">{fn.name}</span>
              <span class="truncate text-[11px] text-muted-foreground">{signatureText(fn)}</span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
