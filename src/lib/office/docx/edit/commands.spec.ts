import { strFromU8, unzipSync } from 'fflate'
import { EditorState, TextSelection, type Command } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { parseDocx, paragraphText, type Paragraph } from '../model'
import { buildDocx, p, r, sectPr } from '../test-utils/builder'
import { clearFormatting, indent, insertTable, linkAt, setAlign, setFormat, setLink, setStyle, splitParagraph, tableCommands, toggleFormat, toggleList } from './commands'
import { openForEditing } from './session'

const STYLES = `
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>`

const BULLETS = `
<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum>
<w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>`

function setup(body: string, extra: { styles?: string; numbering?: string } = {}) {
  const session = openForEditing(buildDocx({ body: body + sectPr(), styles: extra.styles ?? STYLES, numbering: extra.numbering }))
  let state = EditorState.create({ doc: session.initial })
  const run = (cmd: Command) => {
    const ok = cmd(state, (tr) => (state = state.apply(tr)))
    expect(ok).toBe(true)
  }
  const select = (from: number, to = from) => (state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to))))
  /** Selects `text` (its first occurrence). */
  const selectText = (text: string) => {
    let at = -1
    state.doc.descendants((n, pos) => {
      if (at < 0 && n.isText && n.text!.includes(text)) at = pos + n.text!.indexOf(text)
    })
    if (at < 0) throw new Error(`no "${text}"`)
    select(at, at + text.length)
  }
  const saved = () => parseDocx(session.serialize(state.doc))
  const paragraphs = () => saved().sections.flatMap((s) => s.blocks).filter((b): b is Paragraph => b.type === 'paragraph')
  const xml = () => strFromU8(unzipSync(session.serialize(state.doc))['word/document.xml']!)
  return { session, run, select, selectText, saved, paragraphs, xml, state: () => state }
}

describe('docx editing commands', () => {
  it('bold, size and colour write w:b, w:sz and w:color on the run', () => {
    const t = setup(p(r('Make this stand out')))
    t.selectText('this')
    t.run(toggleFormat(t.session.schema.marks.bold!))
    t.run(setFormat(t.session.schema.marks.size!, { halfPoints: 28 }))
    t.run(setFormat(t.session.schema.marks.color!, { hex: 'c00000' }))
    const runs = t.paragraphs()[0]!.inlines
    const run = runs.find((i) => i.type === 'text' && i.text === 'this')
    expect(run).toMatchObject({ run: { bold: true, sizePt: 14, color: '#c00000' } })
    expect(t.xml()).toContain('<w:rPr><w:b/><w:bCs/><w:color w:val="C00000"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t>this</w:t>')
  })

  it('style and alignment apply to every selected paragraph', () => {
    const t = setup(p(r('One')) + p(r('Two')))
    t.select(1, t.state().doc.content.size - 1)
    t.run(setStyle('Heading1'))
    t.run(setAlign('center'))
    expect(t.paragraphs().map((x) => [x.props.styleId, x.props.align, x.props.outlineLevel])).toEqual([
      ['Heading1', 'center', 0],
      ['Heading1', 'center', 0],
    ])
  })

  it('bullets reuse the document’s bullet list; again turns them off; numbering adds a definition', () => {
    const t = setup(p(r('Apples')) + p(r('Pears')), { numbering: BULLETS })
    t.select(1, t.state().doc.content.size - 1)
    t.run(toggleList(t.session, 'bullet'))
    expect(t.paragraphs().map((x) => x.list?.text)).toEqual(['•', '•'])
    expect(t.paragraphs()[0]!.direct.numbering).toEqual({ numId: '5', ilvl: 0 })
    t.run(indent(t.session, 1))
    expect(t.paragraphs().map((x) => x.list?.text)).toEqual(['o', 'o'])
    t.run(toggleList(t.session, 'bullet'))
    expect(t.paragraphs().map((x) => x.list)).toEqual([null, null])
    t.run(toggleList(t.session, 'number'))
    expect(t.paragraphs().map((x) => x.list?.text)).toEqual(['1.', '2.'])
  })

  it('a list started right after another of its kind continues it', () => {
    const li = (text: string) => p(r(text), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>')
    const t = setup(li('First') + p(r('Second')), { numbering: BULLETS })
    t.selectText('Second')
    t.run(toggleList(t.session, 'bullet'))
    expect(t.paragraphs()[1]!.direct.numbering).toEqual({ numId: '5', ilvl: 0 })
  })

  it('indent moves a plain paragraph by half an inch, outdent back', () => {
    const t = setup(p(r('Text')))
    t.select(2)
    t.run(indent(t.session, 1))
    expect(t.paragraphs()[0]!.props.indent?.startPt).toBe(36)
    t.run(indent(t.session, -1))
    expect(t.paragraphs()[0]!.props.indent?.startPt ?? 0).toBe(0)
  })

  it('Enter at the end of a heading starts its next style; in the middle both halves keep it', () => {
    const t = setup(p(r('Title text'), '<w:pStyle w:val="Heading1"/>'))
    t.select(1 + 'Title'.length)
    t.run(splitParagraph(t.session))
    t.select(t.state().doc.child(0).nodeSize + t.state().doc.child(1).nodeSize - 1)
    t.run(splitParagraph(t.session))
    expect(t.paragraphs().map((x) => [paragraphText(x), x.props.styleId])).toEqual([
      ['Title', 'Heading1'],
      [' text', 'Heading1'],
      ['', 'Normal'],
    ])
  })

  it('Enter in an empty list item ends the list', () => {
    const li = (text: string) => p(r(text), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>')
    const t = setup(li('Item') + li(''), { numbering: BULLETS })
    t.select(t.state().doc.child(0).nodeSize + 1)
    t.run(splitParagraph(t.session))
    expect(t.paragraphs().map((x) => x.list?.text ?? null)).toEqual(['•', null])
  })

  it('links: adding, editing (keeps the hyperlink element) and removing', () => {
    const t = setup(p(r('Read the guide now')))
    t.selectText('guide')
    t.run(setLink('https://example.com/a'))
    expect(t.xml()).toMatch(/<w:hyperlink r:id="(rId\d+)"><w:r><w:t>guide<\/w:t><\/w:r><\/w:hyperlink>/)
    t.select(1 + 'Read the gu'.length)
    expect(linkAt(t.state())?.attrs.href).toBe('https://example.com/a')
    t.run(setLink('#results'))
    expect(t.xml()).toContain('<w:hyperlink w:anchor="results"><w:r><w:t>guide</w:t></w:r></w:hyperlink>')
    t.select(1 + 'Read the gu'.length)
    t.run(setLink(null))
    expect(t.xml()).not.toContain('w:hyperlink')
    expect(paragraphText(t.paragraphs()[0]!)).toBe('Read the guide now')
  })

  it('clear formatting removes character marks and direct alignment, keeping the style', () => {
    const t = setup(p(r('Loud', '<w:b/><w:color w:val="FF0000"/><w:lang w:val="de-DE"/>'), '<w:pStyle w:val="Heading1"/><w:jc w:val="right"/>'))
    t.select(1, 5)
    t.run(clearFormatting)
    const para = t.paragraphs()[0]!
    expect(para.props.styleId).toBe('Heading1')
    expect(para.direct.align).toBeUndefined()
    expect(t.xml()).toContain('<w:rPr><w:lang w:val="de-DE"/></w:rPr><w:t>Loud</w:t>')
  })

  it('inserts a table after the paragraph, then adds and deletes rows and columns', () => {
    const t = setup(p(r('Above')))
    t.select(3)
    t.run(insertTable(t.session, 2, 2))
    t.run(tableCommands.addColumn)
    t.run(tableCommands.addRow)
    let table = t.saved().sections[0]!.blocks[1]!
    expect(table.type === 'table' && [table.rows.length, table.grid.length]).toEqual([3, 3])
    t.run(tableCommands.deleteRow)
    t.run(tableCommands.deleteColumn)
    table = t.saved().sections[0]!.blocks[1]!
    expect(table.type === 'table' && [table.rows.length, table.grid.length, table.rows[0]!.cells.length]).toEqual([2, 2, 2])
  })
})
