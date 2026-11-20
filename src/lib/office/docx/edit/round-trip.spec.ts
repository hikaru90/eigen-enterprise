import type { Node as PMNode } from 'prosemirror-model'
import { DOMParser, XMLSerializer, type Node as XmldomNode } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import { EditorState, TextSelection } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { parseDocx, paragraphText } from '../model'
import { buildDocx, inlineImage, p, PNG_1PX, r, sectPr } from '../test-utils/builder'
import { extractText } from '../text'
import { writeDocument } from './serialize'
import { openForEditing } from './session'

const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'

const STYLES = `
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>`

const NUMBERING = `
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`

const fld = (code: string, result: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r(result)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`

/** A document with a bit of everything Word writes, including what the editor doesn't model. */
function richDocx() {
  const body = [
    `<w:p w:rsidR="00A1" w14:paraId="1A2B3C4D" w14:textId="77777777" ${W14}><w:pPr><w:pStyle w:val="Heading1"/><w:rPr><w:lang w:val="en-GB"/></w:rPr></w:pPr><w:r w:rsidRPr="00B2"><w:t>Quarterly report</w:t></w:r></w:p>`,
    `<w:p><w:pPr><w:spacing w:after="120"/><w:jc w:val="both"/></w:pPr>` +
      `<w:r w:rsidR="00C3"><w:rPr><w:i/><w:lang w:val="en-US" w:eastAsia="ja-JP"/></w:rPr><w:t xml:space="preserve">First run, </w:t></w:r>` +
      `<w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b/><w:caps/></w:rPr><w:t>second</w:t></w:r><w:proofErr w:type="spellEnd"/>` +
      `<w:bookmarkStart w:id="0" w:name="results"/><w:r><w:t xml:space="preserve"> third.</w:t></w:r><w:bookmarkEnd w:id="0"/>` +
      `<w:r/><w:r><w:t xml:space="preserve"> Page </w:t></w:r>${fld('PAGE', '1')}` +
      `<w:r><w:footnoteReference w:id="2"/></w:r>` +
      `</w:p>`,
    p(`<w:hyperlink r:id="rIdL" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>our site</w:t></w:r></w:hyperlink>` + r(' and ') + `<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>3</w:t></w:r></w:fldSimple>`),
    p(r('One') + '<w:r><w:tab/></w:r>' + r('Two') + '<w:r><w:br/></w:r>' + r('Three'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    `<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:pPr>${r('End of section one')}</w:p>`,
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>` +
      `<w:tr w:rsidR="00D4"><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr>${p(r('Merged'))}</w:tc></w:tr>` +
      `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${p(r('A'))}</w:tc><w:tc>${p(r('B'))}</w:tc></w:tr>` +
      `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>${p('')}</w:tc><w:tc>${p(r('C'))}</w:tc></w:tr></w:tbl>`,
    `<w:sdt><w:sdtPr><w:alias w:val="Summary"/></w:sdtPr><w:sdtContent>${p(r('Inside a content control'))}</w:sdtContent></w:sdt>`,
    p(inlineImage('rIdImg', 952500, 952500, 'Logo')),
    `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="100" cy="100"/><wp:docPr id="7" name="Shape"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp/></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
    sectPr(),
  ].join('')
  return buildDocx({
    body,
    styles: STYLES,
    numbering: NUMBERING,
    headers: { rIdH: p(r('Header text')) },
    footnotes: `<w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r>${r(' A note.')}</w:p></w:footnote>`,
    media: { rIdImg: { name: 'logo.png', bytes: PNG_1PX } },
    links: { rIdL: 'https://example.com/' },
  })
}

const parts = (bytes: Uint8Array) => unzipSync(bytes)
const docXml = (bytes: Uint8Array) => strFromU8(parts(bytes)['word/document.xml']!)
const ser = (d: XMLDocument) => new XMLSerializer().serializeToString(d as unknown as XmldomNode)
const reparse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as XMLDocument

/** The position just after the first occurrence of `text` in the document. */
function after(doc: PMNode, text: string): number {
  let found = -1
  doc.descendants((n, pos) => {
    if (found >= 0) return false
    if (n.isText && n.text!.includes(text)) found = pos + n.text!.indexOf(text) + text.length
    return true
  })
  if (found < 0) throw new Error(`"${text}" not in the document`)
  return found
}

/** Body children as serialized strings without namespace declarations (serializing one element alone adds them). */
function bodyParts(xml: string): string[] {
  const doc = reparse(xml)
  const body = doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'body')[0]!
  const out: string[] = []
  for (let n = body.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(new XMLSerializer().serializeToString(n as unknown as XmldomNode).replace(/ xmlns:\w+="[^"]*"/g, ''))
  }
  return out
}

describe('docx editing: lossless round trip', () => {
  it('saves an unedited document with every part byte-identical', () => {
    const src = richDocx()
    const session = openForEditing(src)
    const out = session.serialize(session.initial)
    const a = parts(src)
    const b = parts(out)
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort())
    for (const name of Object.keys(a)) expect(b[name], name).toEqual(a[name])
  })

  it('writes an unedited body back as exactly the source XML (every element reused)', () => {
    const session = openForEditing(richDocx())
    const { docx } = session
    const pristine = docx.pkg.xml(docx.mainPart)
    const out = writeDocument(
      { pkg: docx.pkg, mainPart: docx.mainPart, reg: session.registry, pristine, linkRels: new Map(), textWidthTwips: 9000, firstDocPrId: 100 },
      session.initial,
    )
    expect(ser(out)).toBe(ser(pristine))
  })

  it('an edit to one run rewrites only that run', () => {
    const src = richDocx()
    const session = openForEditing(src)
    const state = EditorState.create({ doc: session.initial })
    const tr = state.tr.insertText(' and more', after(state.doc, 'second'))
    const out = session.serialize(tr.doc)
    const before = bodyParts(docXml(src))
    const now = bodyParts(docXml(out))
    expect(now).toHaveLength(before.length)
    const changed = now.map((x, i) => (x === before[i] ? null : i)).filter((i) => i !== null)
    expect(changed).toEqual([1])
    // Inside the paragraph: the same XML except the one run's text.
    expect(now[1]).toBe(before[1]!.replace('<w:t>second</w:t>', '<w:t>second and more</w:t>'))
    // Styles, numbering, header, footnotes, media untouched.
    for (const name of ['word/styles.xml', 'word/numbering.xml', 'word/header-rIdH.xml', 'word/footnotes.xml', 'word/media/logo.png', 'word/_rels/document.xml.rels', '[Content_Types].xml']) {
      expect(parts(out)[name], name).toEqual(parts(src)[name])
    }
  })

  it('bolding part of a run splits it, keeping the run’s other properties and attributes', () => {
    const src = richDocx()
    const session = openForEditing(src)
    const state = EditorState.create({ doc: session.initial })
    const end = after(state.doc, 'First run')
    const tr = state.tr.addMark(end - 'run'.length, end, session.schema.marks.bold!.create())
    const xml = bodyParts(docXml(session.serialize(tr.doc)))[1]!
    expect(xml).toContain('<w:r w:rsidR="00C3"><w:rPr><w:i/><w:lang w:val="en-US" w:eastAsia="ja-JP"/></w:rPr><w:t>First </w:t></w:r>'.replace('<w:t>', '<w:t xml:space="preserve">'))
    expect(xml).toContain('<w:r w:rsidR="00C3"><w:rPr><w:b/><w:bCs/><w:i/><w:lang w:val="en-US" w:eastAsia="ja-JP"/></w:rPr><w:t>run</w:t></w:r>')
    expect(xml).toContain('<w:r w:rsidR="00C3"><w:rPr><w:i/><w:lang w:val="en-US" w:eastAsia="ja-JP"/></w:rPr><w:t xml:space="preserve">, </w:t></w:r>')
    // Everything else in the paragraph is as it was.
    expect(xml).toContain('<w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b/><w:caps/></w:rPr><w:t>second</w:t></w:r><w:proofErr w:type="spellEnd"/>')
    expect(xml).toContain('<w:r/>')
    expect(xml).toContain('<w:r><w:footnoteReference w:id="2"/></w:r>')
    expect(xml).toContain('<w:instrText xml:space="preserve"> PAGE </w:instrText>')
  })

  it('splitting a paragraph keeps its properties on both halves; the copy gets no duplicate paragraph id', () => {
    const src = richDocx()
    const session = openForEditing(src)
    const state = EditorState.create({ doc: session.initial })
    const tr = state.tr.split(after(state.doc, 'Quarterly'))
    const body = bodyParts(docXml(session.serialize(tr.doc)))
    expect(body[0]).toContain('w14:paraId="1A2B3C4D"')
    expect(body[0]).toContain('<w:pStyle w:val="Heading1"/>')
    expect(body[1]).not.toContain('w14:paraId')
    expect(body[1]).toContain('w:rsidR="00A1"')
    expect(body[1]).toContain('<w:pPr><w:pStyle w:val="Heading1"/><w:rPr><w:lang w:val="en-GB"/></w:rPr></w:pPr>')
    const doc = parseDocx(session.serialize(tr.doc))
    expect(doc.sections[0]!.blocks.slice(0, 2).map((b) => (b.type === 'paragraph' ? paragraphText(b) : ''))).toEqual(['Quarterly', ' report'])
  })

  it('a paragraph style or alignment change rewrites w:pPr in schema order, keeping the rest', () => {
    const src = richDocx()
    const session = openForEditing(src)
    const state = EditorState.create({ doc: session.initial })
    let pos = -1
    state.doc.forEach((n, offset, i) => {
      if (i === 1) pos = offset
    })
    const node = state.doc.nodeAt(pos)!
    const tr = state.tr.setNodeMarkup(pos, null, { ...node.attrs, styleId: 'Heading1', jc: 'center', ind: { start: 720 } })
    const xml = bodyParts(docXml(session.serialize(tr.doc)))[1]!
    expect(xml).toMatch(/^<w:p><w:pPr><w:pStyle w:val="Heading1"\/><w:spacing w:after="120"\/><w:ind w:left="720"\/><w:jc w:val="center"\/><\/w:pPr><w:r w:rsidR="00C3">/)
  })

  it('deleting a section break takes the w:sectPr off its paragraph; the final section stays', () => {
    const src = richDocx()
    const session = openForEditing(src)
    const state = EditorState.create({ doc: session.initial })
    let pos = -1
    state.doc.forEach((n, offset) => {
      if (n.type.name === 'section_break') pos = offset
    })
    const tr = state.tr.delete(pos, pos + 1)
    const out = session.serialize(tr.doc)
    const xml = docXml(out)
    expect(xml.match(/<w:sectPr>/g)).toHaveLength(1)
    expect(parseDocx(out).sections).toHaveLength(1)
  })

  it('keeps a vertically merged table when a cell’s text changes; new columns get a new grid', () => {
    const src = richDocx()
    const session = openForEditing(src)
    const state = EditorState.create({ doc: session.initial })
    const tr = state.tr.insertText('!', after(state.doc, 'B'))
    const out = session.serialize(tr.doc)
    const table = bodyParts(docXml(out)).find((x) => x.startsWith('<w:tbl>'))!
    const before = bodyParts(docXml(src)).find((x) => x.startsWith('<w:tbl>'))!
    expect(table).toBe(before.replace('<w:t xml:space="preserve">B</w:t>', '<w:t>B!</w:t>'))
    const model = parseDocx(out).sections[1]!.blocks.find((b) => b.type === 'table')
    expect(model?.type === 'table' && model.rows[2]!.cells[0]!.props.vMerge).toBe('continue')
  })

  it('carries what it does not model — fields, content controls, shapes, notes — unchanged through an edit', () => {
    const src = richDocx()
    const session = openForEditing(src)
    const state = EditorState.create({ doc: session.initial })
    // Touch every paragraph-level container around them.
    let tr = state.tr.insertText('X', after(state.doc, 'One'))
    tr = tr.insertText('Y', after(tr.doc, ' and '))
    const before = bodyParts(docXml(src))
    const now = bodyParts(docXml(session.serialize(tr.doc)))
    expect(now[2]).toContain('<w:hyperlink r:id="rIdL" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>our site</w:t></w:r></w:hyperlink>')
    expect(now[2]).toContain('<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>3</w:t></w:r></w:fldSimple>')
    expect(now[3]).toContain('<w:r><w:tab/></w:r>')
    expect(now[3]).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
    for (const i of [6, 7, 8]) expect(now[i]).toBe(before[i])
  })

  it('a table with a row that has no cells is kept byte-identical, not edited in place', () => {
    const table = `<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc>${p(r('Cell'))}</w:tc></w:tr><w:tr><w:trPr/></w:tr></w:tbl>`
    const src = buildDocx({ body: p(r('Text')) + table + sectPr() })
    const session = openForEditing(src)
    // The editor carries such a table as one piece instead of rows and cells.
    expect(session.initial.child(1).type.name).toBe('opaque_block')
    const state = EditorState.create({ doc: session.initial })
    const out = session.serialize(state.tr.insertText('!', after(state.doc, 'Text')).doc)
    expect(bodyParts(docXml(out))[1]).toBe(bodyParts(docXml(src))[1])
  })
})

describe('docx editing: new content', () => {
  it('adds a link as a hyperlink with an external relationship', () => {
    const session = openForEditing(buildDocx({ body: p(r('Visit us today')) + sectPr() }))
    const state = EditorState.create({ doc: session.initial })
    const end = after(state.doc, 'Visit us')
    const tr = state.tr.addMark(end - 2, end, session.schema.marks.link!.create({ href: 'https://kindred.example/' }))
    const out = session.serialize(tr.doc)
    const doc = parseDocx(out)
    const para = doc.sections[0]!.blocks[0]!
    expect(para.type === 'paragraph' && para.inlines.find((i) => i.type === 'link')).toMatchObject({ href: 'https://kindred.example/' })
    expect(docXml(out)).toMatch(/<w:hyperlink r:id="rId\d+"><w:r><w:t>us<\/w:t><\/w:r><\/w:hyperlink>/)
  })

  it('inserts a picture as a media part with a relationship', () => {
    const session = openForEditing(buildDocx({ body: p(r('Logo: ')) + sectPr() }))
    const { part, rId } = session.addImage(PNG_1PX, 'image/png')
    const state = EditorState.create({ doc: session.initial })
    const img = session.schema.nodes.image!.create({ part, rId, contentType: 'image/png', widthPt: 72, heightPt: 36, alt: 'Our logo', name: 'logo.png' })
    const out = session.serialize(state.tr.insert(after(state.doc, 'Logo: '), img).doc)
    const doc = parseDocx(out)
    const para = doc.sections[0]!.blocks[0]!
    const image = para.type === 'paragraph' ? para.inlines.find((i) => i.type === 'image') : undefined
    expect(image).toMatchObject({ type: 'image', part: '/word/media/added-1.png', contentType: 'image/png', widthPt: 72, heightPt: 36, alt: 'Our logo' })
    expect(doc.pkg.bytes('/word/media/added-1.png')).toEqual(PNG_1PX)
  })

  it('inserts a table that Word-shaped readers see with its grid and rows', () => {
    const session = openForEditing(buildDocx({ body: p(r('Before')) + sectPr() }))
    const { schema } = session
    const cell = (t: string) => schema.nodes.table_cell!.create(null, schema.nodes.paragraph!.create(null, t ? schema.text(t) : null))
    const table = schema.nodes.table!.create(null, [schema.nodes.table_row!.create(null, [cell('a'), cell('b')]), schema.nodes.table_row!.create(null, [cell(''), cell('d')])])
    const state = EditorState.create({ doc: session.initial })
    const out = session.serialize(state.tr.insert(state.doc.content.size, table).doc)
    const t = parseDocx(out).sections[0]!.blocks[1]!
    expect(t.type).toBe('table')
    if (t.type !== 'table') return
    expect(t.grid).toHaveLength(2)
    expect(t.rows.map((row) => row.cells.map((c) => c.blocks.map((b) => (b.type === 'paragraph' ? paragraphText(b) : '')).join('')))).toEqual([
      ['a', 'b'],
      ['', 'd'],
    ])
  })

  it('starts a numbered list in a document without numbering by adding numbering.xml', () => {
    const session = openForEditing(buildDocx({ body: p(r('First')) + p(r('Second')) + sectPr() }))
    const numId = session.newList('number')
    const state = EditorState.create({ doc: session.initial })
    const tr = state.tr
    state.doc.forEach((n, offset) => {
      tr.setNodeMarkup(offset, null, { ...n.attrs, numId, ilvl: 0 })
    })
    const out = session.serialize(tr.doc)
    const doc = parseDocx(out)
    const labels = doc.sections[0]!.blocks.map((b) => (b.type === 'paragraph' ? b.list?.text : null))
    expect(labels).toEqual(['1.', '2.'])
  })

  it('the text for agents reads the edited file', async () => {
    const session = openForEditing(richDocx())
    const state = EditorState.create({ doc: session.initial })
    let tr = state.tr.insertText(' (final)', after(state.doc, 'Quarterly report'))
    tr = tr.setSelection(TextSelection.create(tr.doc, 1))
    const md = await extractText(session.serialize(tr.doc))
    expect(md).toContain('# Quarterly report (final)')
    expect(md).toContain('[our site](https://example.com/)')
    expect(md).toContain('Inside a content control')
  })
})
