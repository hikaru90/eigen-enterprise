import { describe, expect, it } from 'vitest'
import { extractOfficeText } from '../text'
import { brokenPdf, encryptedPdf, makePdf } from './fixtures'
import { extractText, PdfPasswordError } from './text'

describe('PDF text for agents (extractText)', () => {
  it('one section per page, the title from the metadata, paragraphs from line spacing', async () => {
    const bytes = await makePdf(
      [
        {
          lines: [
            'Quarterly report',
            '',
            'Revenue grew in every region',
            'and costs fell slightly.',
            '',
            'Outlook is steady.',
          ],
        },
        { lines: ['Second page text.'] },
        { lines: [] },
      ],
      { title: 'Harbour Report 2026' },
    )
    expect(await extractText(bytes)).toBe(
      [
        '# Harbour Report 2026',
        '',
        '## Page 1',
        '',
        'Quarterly report',
        '',
        'Revenue grew in every region and costs fell slightly.',
        '',
        'Outlook is steady.',
        '',
        '## Page 2',
        '',
        'Second page text.',
        '',
        '## Page 3',
        '',
        '_(no text on this page)_',
        '',
      ].join('\n'),
    )
  })

  it('names pages by their labels (/PageLabels) and keeps the page number', async () => {
    const bytes = await makePdf(
      [
        { lines: ['Cover'] },
        { lines: ['Preface'] },
        { lines: ['Chapter one'] },
        { lines: ['More'] },
      ],
      {
        labels: [
          { from: 0, prefix: 'Cover' },
          { from: 1, style: 'r' },
          { from: 2, style: 'D' },
        ],
      },
    )
    const text = await extractText(bytes)
    expect(text).not.toMatch(/^# /m)
    expect(text.match(/^## .*$/gm)).toEqual([
      '## Page Cover (page 1)',
      '## Page i (page 2)',
      '## Page 1 (page 3)',
      '## Page 2 (page 4)',
    ])
  })

  it('keeps the reading order of the content (lines top to bottom)', async () => {
    const bytes = await makePdf([{ lines: ['alpha line', 'beta line', 'gamma line'] }])
    const text = await extractText(bytes)
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('beta'))
    expect(text.indexOf('beta')).toBeLessThan(text.indexOf('gamma'))
    expect(text).toContain('alpha line beta line gamma line')
  })

  it('reads rotated pages like upright ones', async () => {
    const bytes = await makePdf([{ lines: ['Turned page', 'second line'], rotate: 90 }])
    expect(await extractText(bytes)).toContain('Turned page second line')
  })

  it('an encrypted PDF without its password fails with a clear error', async () => {
    const bytes = encryptedPdf('s3cret', 'Hidden text')
    await expect(extractText(bytes)).rejects.toBeInstanceOf(PdfPasswordError)
    await expect(extractText(bytes)).rejects.toThrow(
      'This PDF is password-protected, so its text can’t be read.',
    )
  })

  it('a broken file fails loudly', async () => {
    await expect(extractText(brokenPdf())).rejects.toThrow(/PDF/)
  })

  it('is what drive.read gets for a PDF', async () => {
    const bytes = await makePdf([{ lines: ['Through the hook'] }])
    expect(await extractOfficeText('pdf', bytes)).toContain('Through the hook')
  })
})

describe('extractText: notes and markups (what reviewers wrote on the PDF)', () => {
  it('lists each page’s notes, markups and text boxes under it, replies nested, review state shown', async () => {
    const { applyPdfEdits } = await import('./edit')
    const source = await makePdf([{ lines: ['Revenue grew in the third quarter'] }, { lines: ['Next steps'] }])
    const now = new Date('2026-11-21T10:00:00Z')
    const first = await applyPdfEdits(
      { bytes: source },
      {
        annotations: [
          { op: 'add', key: 'n1', annotation: { page: 0, shape: { kind: 'Text', at: [72, 700] }, color: [1, 0.8, 0], opacity: 1, contents: 'Check this number' } },
          { op: 'add', key: 'h1', annotation: { page: 1, shape: { kind: 'Highlight', quads: [[72, 720, 160, 720, 72, 706, 160, 706]] }, color: [1, 1, 0], opacity: 0.4, contents: 'Owner?' } },
          { op: 'add', key: 'i1', annotation: { page: 1, shape: { kind: 'Ink', paths: [[80, 600, 120, 620]], width: 2 }, color: [0, 0, 1], opacity: 1 } },
        ],
      },
      { author: 'Ada Owner', now },
    )
    const second = await applyPdfEdits(
      { bytes: first.bytes },
      { annotations: [{ op: 'reply', key: 'r1', to: first.created.n1!, contents: 'It is right' }, { op: 'review', id: first.created.n1!, state: 'Completed' }] },
      { author: 'Ben Member', now },
    )
    const md = await extractText(second.bytes)
    const page1 = md.slice(md.indexOf('## Page 1'), md.indexOf('## Page 2'))
    const page2 = md.slice(md.indexOf('## Page 2'))
    expect(page1).toContain('> Note (Ada Owner, completed): Check this number')
    expect(page1).toContain('>> Reply (Ben Member): It is right')
    expect(page2).toContain('> Highlight (Ada Owner): Owner?')
    // A drawing without words is still listed, so the agent knows it is there.
    expect(page2).toContain('> Ink drawing (Ada Owner)')
    expect(page2).not.toContain('Check this number')
  })

  it('a PDF without annotations reads as before (no comments section)', async () => {
    const md = await extractText(await makePdf([{ lines: ['Plain page'] }]))
    expect(md).not.toContain('> ')
  })
})
