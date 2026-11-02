import { env } from '$env/dynamic/private'
import { loadPickerIndex, pickerIndexSourceFromEnv, type PickerTree } from '../../../../modules/brand/taxonomy/load-index'

/** The brand-picker index this server serves (BRAND_PICKER_INDEX: built | fixture). Fails loud. */
export function pickerTree(): PickerTree {
  return loadPickerIndex(pickerIndexSourceFromEnv(env.BRAND_PICKER_INDEX))
}
