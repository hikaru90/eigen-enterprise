import { describe, expect, it } from 'vitest'
import { driveNameForTitle } from './service'

/**
 * Memory documents are Drive files (drizzle/0191); their behaviour on the
 * database and Drive is drive-documents.integration.spec.ts. Here: the Drive
 * file name a title becomes (Drive refuses / and \ and names over 255).
 */
describe('driveNameForTitle', () => {
  it('is the title as a Markdown file name', () => {
    expect(driveNameForTitle('Launch checklist')).toBe('Launch checklist.md')
  })
  it('replaces the separators Drive refuses and folds whitespace', () => {
    expect(driveNameForTitle('Q3 / Q4\\plan\n  draft')).toBe('Q3 - Q4-plan draft.md')
  })
  it('names an untitled document', () => {
    expect(driveNameForTitle('')).toBe('Untitled document.md')
    expect(driveNameForTitle('..')).toBe('Untitled document.md')
  })
  it('stays within Drive’s 255 characters', () => {
    expect(driveNameForTitle('x'.repeat(400)).length).toBeLessThanOrEqual(255)
  })
})
