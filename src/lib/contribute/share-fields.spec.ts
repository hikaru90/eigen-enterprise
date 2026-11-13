import { describe, expect, it } from 'vitest'
import { HUB_CONTRIBUTION_KEYS } from '../../../modules/contribute/share/contract'
import { SHARED_FIELDS } from './share-fields'

describe('the field list Settings shows', () => {
  it('has one line per contract field, in the contract order', () => {
    expect(Object.keys(SHARED_FIELDS)).toEqual(HUB_CONTRIBUTION_KEYS)
  })
})
