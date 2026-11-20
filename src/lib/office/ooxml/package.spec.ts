import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { OpcError, readPackage, REL_OFFICE_DOCUMENT } from './package'

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="PNG" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${REL_OFFICE_DOCUMENT}" Target="word/document.xml"/>
</Relationships>`
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="../word/styles.xml"/>
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a?b=1" TargetMode="External"/>
</Relationships>`
const DOC = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:x="urn:unknown"><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p><x:future keep="me"/></w:body></w:document>`

function sample(extra: Record<string, Uint8Array> = {}) {
  return zipSync({
    '[Content_Types].xml': strToU8(CT),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(DOC),
    'word/_rels/document.xml.rels': strToU8(DOC_RELS),
    'word/styles.xml': strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'),
    'word/media/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    'customXml/item1.xml': strToU8('<unknown-to-us/>'),
    ...extra,
  })
}

describe('OPC package (ECMA-376 Part 2)', () => {
  it('lists parts by part name and resolves content types (Override, then Default by extension, case-insensitive)', () => {
    const pkg = readPackage(sample())
    expect(pkg.partNames()).toContain('/word/document.xml')
    expect(pkg.partNames()).not.toContain('/[Content_Types].xml')
    expect(pkg.contentType('/word/document.xml')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
    expect(pkg.contentType('/WORD/Document.xml')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
    expect(pkg.contentType('/word/media/logo.png')).toBe('image/png')
    expect(pkg.contentType('/word/styles.xml')).toBe('application/xml')
  })

  it('reads relationships and resolves internal targets against the source part', () => {
    const pkg = readPackage(sample())
    expect(pkg.mainPart(REL_OFFICE_DOCUMENT)).toBe('/word/document.xml')
    const rels = pkg.relationships('/word/document.xml')
    expect(rels.map((r) => [r.id, r.part ?? r.target])).toEqual([
      ['rId5', '/word/media/logo.png'],
      ['rId6', '/word/styles.xml'],
      ['rId7', 'https://example.com/a?b=1'],
    ])
    expect(rels[2]).toMatchObject({ external: true, part: null })
    expect(pkg.relationships('/word/styles.xml')).toEqual([])
  })

  it('round-trips losslessly: untouched parts keep their exact bytes, unknown parts and markup included', () => {
    const before = unzipSync(sample())
    const after = unzipSync(readPackage(sample()).toBytes())
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    for (const k of Object.keys(before)) expect(after[k]).toEqual(before[k])
    expect(Object.keys(after)[0]).toBe('[Content_Types].xml')
  })

  it('edits XML through a DOM and keeps markup it does not know', () => {
    const pkg = readPackage(sample())
    const doc = pkg.xml('/word/document.xml')
    doc.getElementsByTagName('w:t')[0]!.textContent = 'Hello'
    pkg.setXml('/word/document.xml', doc)
    const out = strFromU8(unzipSync(pkg.toBytes())['word/document.xml']!)
    expect(out).toContain('<w:t>Hello</w:t>')
    expect(out).toContain('<x:future keep="me"/>')
  })

  it('adds a part with its content type and a relationship to it (next free id)', () => {
    const pkg = readPackage(sample())
    pkg.setBytes('/word/media/chart.svg', strToU8('<svg/>'), 'image/svg+xml')
    const id = pkg.addRelationship('/word/document.xml', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', 'media/chart.svg')
    expect(id).toBe('rId8')
    const again = readPackage(pkg.toBytes())
    expect(again.contentType('/word/media/chart.svg')).toBe('image/svg+xml')
    expect(again.relationships('/word/document.xml').find((r) => r.id === 'rId8')?.part).toBe('/word/media/chart.svg')
  })

  it('removes a part and its override', () => {
    const pkg = readPackage(sample())
    pkg.remove('/word/document.xml')
    const again = readPackage(pkg.toBytes())
    expect(again.has('/word/document.xml')).toBe(false)
    expect(() => again.contentType('/word/document.xml')).toThrow(OpcError)
  })

  it('fails loud on what is not an OPC package', () => {
    expect(() => readPackage(strToU8('%PDF-1.7'))).toThrow(OpcError)
    expect(() => readPackage(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/\[Content_Types\]\.xml/)
    const pkg = readPackage(sample())
    expect(() => pkg.bytes('/nope.xml')).toThrow(/no part \/nope\.xml/)
    const broken = readPackage(sample({ 'word/document.xml': strToU8('<w:document><w:body></w:document>') }))
    expect(() => broken.xml('/word/document.xml')).toThrow(OpcError)
    expect(() => broken.xml('/word/document.xml')).toThrow(/\/word\/document\.xml is not well-formed XML/)
  })
})
