import { describe, expect, it } from 'vitest'
import { flowItems, formatPageNumber, headerFooterFor, splitAtPageBreaks } from './flow'
import { fontStack } from './fonts'
import { inlineText, parseDocx, type FontInfo, type Paragraph } from './model'
import { symbolChar, symbolText } from './symbols'
import { buildDocx, p, r, sectPr } from './test-utils/builder'

const blocks = (body: string) => parseDocx(buildDocx({ body: body + sectPr() })).sections[0]!.blocks

describe('docx flow: paragraphs cut at page breaks', () => {
  it('cuts inside links and keeps each piece flagged first/last', () => {
    const [para] = blocks(p(r('a') + '<w:hyperlink w:anchor="x"><w:r><w:t>b</w:t><w:br w:type="page"/><w:t>c</w:t></w:r></w:hyperlink>' + r('d')))
    const pieces = splitAtPageBreaks((para as Paragraph).inlines)
    expect(pieces.map(inlineText)).toEqual(['ab', 'cd'])
    expect(pieces[1]![0]).toMatchObject({ type: 'link', anchor: 'x' })
    const items = flowItems([para!])
    expect(items.map((i) => i.kind === 'paragraph' && [i.first, i.last, i.breakBefore])).toEqual([
      [true, false, false],
      [false, true, true],
    ])
  })

  it('starts the next block on a new page after a paragraph ending in a page break, and honours pageBreakBefore', () => {
    const items = flowItems(blocks(p('<w:r><w:t>a</w:t><w:br w:type="page"/></w:r>') + p(r('b')) + p(r('c'), '<w:pageBreakBefore/>') + p(r('d'), '<w:keepNext/>')))
    expect(items.map((i) => (i.kind === 'paragraph' ? [inlineText(i.inlines), i.breakBefore, i.keepNext] : null))).toEqual([
      ['a', false, false],
      ['', true, false],
      ['b', false, false],
      ['c', true, false],
      ['d', false, true],
    ])
  })

  it('takes no room for the empty piece of a paragraph that starts with a page break', () => {
    const items = flowItems(blocks(p(r('a')) + p('<w:r><w:br w:type="page"/><w:t>b</w:t></w:r>')))
    expect(items.map((i) => (i.kind === 'paragraph' ? [inlineText(i.inlines), i.breakBefore] : null))).toEqual([
      ['a', false],
      ['b', true],
    ])
  })
})

describe('docx flow: page numbers and header choice', () => {
  it('formats page numbers in the section format', () => {
    expect(formatPageNumber(4, undefined)).toBe('4')
    expect(formatPageNumber(4, 'lowerRoman')).toBe('iv')
    expect(formatPageNumber(4, 'upperLetter')).toBe('D')
    expect(formatPageNumber(4, 'numberInDash')).toBe('- 4 -')
  })

  it('uses first, even and default headers as the section and settings say', () => {
    const doc = parseDocx(
      buildDocx({
        headers: { a: p(r('d')), b: p(r('f')), c: p(r('e')) },
        body: p(r('x')) + sectPr('<w:headerReference w:type="default" r:id="a"/><w:headerReference w:type="first" r:id="b"/><w:headerReference w:type="even" r:id="c"/><w:titlePg/>'),
      }),
    )
    const s = doc.sections[0]!
    const pick = (i: number, n: number, evenOdd: boolean) => headerFooterFor(s, i, n, { defaultTabStopPt: 36, evenAndOddHeaders: evenOdd, trackRevisions: false }).header
    expect(pick(0, 1, true)).toBe('/word/header-b.xml')
    expect(pick(1, 2, true)).toBe('/word/header-c.xml')
    expect(pick(2, 3, true)).toBe('/word/header-a.xml')
    expect(pick(1, 2, false)).toBe('/word/header-a.xml')
  })
})

describe('docx fonts and symbols', () => {
  const table = new Map<string, FontInfo>([
    ['Garamond', { name: 'Garamond', altName: null, family: 'roman', pitch: 'variable' }],
    ['Fixedsys', { name: 'Fixedsys', altName: null, family: 'auto', pitch: 'fixed' }],
  ])

  it('puts the named font first, then substitutes and the East Asian font, ending in the generic family from the font table', () => {
    expect(fontStack('Calibri', 'MS Mincho', new Map())).toBe('"Calibri", "Carlito", "MS Mincho", "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", "Noto Serif JP", sans-serif')
    expect(fontStack('Garamond', undefined, table)).toBe('"Garamond", serif')
    expect(fontStack('Fixedsys', undefined, table)).toBe('"Fixedsys", monospace')
    expect(fontStack(undefined, undefined, table)).toBe('sans-serif')
  })

  it('maps Symbol and Wingdings codes (also in the private use area) to Unicode, and leaves others in their font', () => {
    expect(symbolChar('Symbol', 0xf0b7)).toEqual({ char: '•', mapped: true })
    expect(symbolChar('Wingdings', 0xf0fc)).toEqual({ char: '✓', mapped: true })
    expect(symbolChar('Wingdings', 0x00a7)).toEqual({ char: '▪', mapped: true })
    expect(symbolChar('Webdings', 0xf041)).toEqual({ char: '', mapped: false })
    expect(symbolText('Symbol', '')).toEqual({ text: '•', mapped: true })
    expect(symbolText('Courier New', 'o')).toEqual({ text: 'o', mapped: false })
  })
})
