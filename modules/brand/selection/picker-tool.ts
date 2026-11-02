import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { defaultBrandStore, type BrandStore, type BrandVisualSet } from '../store'
import { loadPickerIndex, pickerIndexSourceFromEnv, toVisualSetVars, type PickerTree } from '../taxonomy/load-index'

/**
 * The brand picker's "Choose this style" (plan/phase-brand-picker.md §3.3): one
 * owner click turns a final-level picker node into the company's active visual
 * set — light tokens → cssVars, dark tokens → darkCssVars — retiring the
 * previous active set in the same store operation (activateVisualSet).
 *
 * Not approval-gated: the owner's click on the page IS the human decision (D11
 * precedent, plan/phase-platform.md). Fail closed: human principal AND the
 * owner role; agents and admins are refused (they can still browse the picker
 * and use the approval-gated brand.visual_set_activate path).
 */

export type BrandPickerToolDeps = {
  store?: BrandStore
  /** Overrides the bundled index (tests inject the fixture). */
  pickerIndex?: () => PickerTree
}

const pickerChooseInput = z.object({ nodeId: z.string().min(1) })

function requireOwnerHuman(ctx: ToolContext): void {
  if (ctx.principal.kind !== 'human' || !ctx.principal.roles.includes('owner')) {
    throw new KernelError(
      'permission_denied',
      `choosing the company style is the owner's own click; principal ${ctx.principal.id} (${ctx.principal.kind}) is not the owner`,
    )
  }
}

export function createBrandPickerChooseTool(deps: BrandPickerToolDeps = {}): ToolDescriptor {
  const store = deps.store ?? defaultBrandStore()
  const pickerIndex = deps.pickerIndex ?? (() => loadPickerIndex(pickerIndexSourceFromEnv(process.env.BRAND_PICKER_INDEX)))
  return {
    name: 'brand.picker_choose',
    module: 'brand',
    summary:
      "Owner-only: make a final-level brand-picker style the company's active visual set (light → cssVars, dark → darkCssVars), retiring the previous one. The owner's click is the human decision (D11); agents are refused.",
    auditClass: 'mutate',
    activity: (_input: unknown, output?: BrandVisualSet) =>
      output ? `Chose the visual style “${output.name}”` : 'Chose a visual style',
    inputSchema: pickerChooseInput,
    permission: { roles: ['owner'] },
    handler: async (ctx, input) => {
      requireOwnerHuman(ctx)
      const { nodeId } = pickerChooseInput.parse(input)
      const node = pickerIndex().get(nodeId)
      if (!node) throw new KernelError('invalid_input', `unknown brand picker node "${nodeId}"`)
      if (node.level !== 'variant') {
        throw new KernelError('invalid_input', `brand picker node "${nodeId}" is a ${node.level}; only a final-level style can be chosen`)
      }
      const draft = await store.createVisualSet({
        name: node.name,
        pickedItemIds: [],
        pickerNodeId: node.id,
        cssVars: toVisualSetVars(node.tokens.light),
        darkCssVars: toVisualSetVars(node.tokens.dark),
      })
      return store.activateVisualSet(draft.id)
    },
  }
}
