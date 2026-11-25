import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readCellImages } from './cell-images'
import { anchorBox, readDrawing, sheetGeometry, type AnchoredObject } from './drawing'
import { SHAPE_GEOMETRIES } from './drawing-ops'
import { createSheetEditor, workbookNotes } from './editor'
import { imageInfo } from './image-info'
import { lossesOf } from './ops'
import { buildXlsx, num, row } from './test-utils/build-xlsx'
import { DRAWING_XML, pictureBook, png } from './test-utils/drawing-fixtures'
import { openWorkbook } from './workbook'

const files = (bytes: Uint8Array) => unzipSync(bytes)
const text = (bytes: Uint8Array, name: string) => strFromU8(files(bytes)[name]!)
const objects = (bytes: Uint8Array, sheet = 'Pics'): AnchoredObject[] => {
  const wb = openWorkbook(bytes)
  return readDrawing(wb, wb.requireWorksheet(sheet))
}
const byName = (list: AnchoredObject[], name: string) => list.find((o) => o.name === name)!

describe('reading a sheet drawing', () => {
  it('reads pictures, shapes, text boxes, chart frames and groups as Excel writes them', () => {
    const list = objects(pictureBook())
    expect(list.map((o) => [o.id, o.kind, o.name])).toEqual([
      ['2', 'picture', 'Picture 1'],
      ['3', 'shape', 'Rectangle 2'],
      ['4', 'textbox', 'TextBox 3'],
      ['5', 'chart', 'Chart 4'],
      ['6', 'group', 'Group 5'],
    ])
    const pic = byName(list, 'Picture 1')
    expect(pic.alt).toBe('Company logo')
    expect(pic.image).toEqual({ part: '/xl/media/image1.png', contentType: 'image/png' })
    expect(pic.crop).toEqual({ l: 0.1, t: 0.05, r: 0.2, b: 0 })
    expect(pic.rotation).toBe(90)
    expect(pic.anchor).toEqual({
      type: 'twoCell',
      editAs: 'oneCell',
      from: { col: 1, colOff: 0, row: 1, rowOff: 0 },
      to: { col: 3, colOff: 304800, row: 5, rowOff: 95250 },
    })
    const rect = byName(list, 'Rectangle 2')
    // Default shape style: accent1 fill, accent1 at 50 % shade outline, light text.
    expect(rect.geometry).toBe('rect')
    expect(rect.fill).toBe('#4472C4')
    expect(rect.line?.color).toMatch(/^#[0-9A-F]{6}$/)
    expect(rect.line?.color).not.toBe('#4472C4')
    expect(rect.text).toBe('Q3 target\nmet')
    expect(rect.textColor).toBe('#FFFFFF')
    const box = byName(list, 'TextBox 3')
    expect(box.fill).toBe('#FFFF00')
    expect(box.line).toMatchObject({ color: '#000000', widthPx: 1 })
    expect(box.anchor).toEqual({ type: 'absolute', pos: { x: 95250, y: 1905000 }, ext: { cx: 952500, cy: 476250 } })
    expect(byName(list, 'Chart 4').chartPart).toBe('/xl/charts/chart1.xml')
    const group = byName(list, 'Group 5')
    expect(group.children).toHaveLength(1)
    expect(group.children![0]).toMatchObject({ kind: 'shape', geometry: 'ellipse', fill: '#70AD47' })
  })

  it('places anchors in sheet pixels from the column widths and row heights', () => {
    const wb = openWorkbook(pictureBook())
    const g = sheetGeometry(wb.sheet('Pics'))
    const [pic, , tb] = readDrawing(wb, wb.requireWorksheet('Pics'), g)
    // B2 = (64, 20); to D6 + 32 px / + 10 px.
    expect(anchorBox(pic!.anchor!, g)).toEqual({ x: 64, y: 20, w: 64 * 2 + 32, h: 20 * 4 + 10 })
    expect(anchorBox(tb!.anchor!, g)).toEqual({ x: 10, y: 200, w: 100, h: 50 })
  })

  it('a workbook without drawings has none, and the notes bar no longer lists shown drawings', () => {
    expect(objects(buildXlsx({ sheets: [{ name: 'Pics', rows: row(1, num('A1', 1)) }] }))).toEqual([])
    const ed = createSheetEditor(pictureBook())
    expect(workbookNotes(ed).find((n) => n.kind === 'drawings')).toBeUndefined()
  })
})

describe('editing pictures and shapes', () => {
  it('keeps the drawing, its media and the chart byte for byte when only cells change', () => {
    const before = pictureBook()
    const ed = createSheetEditor(before)
    ed.apply({ op: 'set_cells', sheet: 'Pics', cells: [{ ref: 'A2', value: 5 }] })
    const after = ed.toBytes()
    for (const p of ['xl/drawings/drawing1.xml', 'xl/media/image1.png', 'xl/charts/chart1.xml', 'xl/drawings/_rels/drawing1.xml.rels'])
      expect(files(after)[p], p).toEqual(files(before)[p])
  })

  it('inserts a picture into a sheet without a drawing: part, relationships, content types, <drawing>', () => {
    const ed = createSheetEditor(pictureBook())
    const res = ed.apply({ op: 'insert_picture', sheet: 'Other', image: png(1280, 720), x: 64, y: 20, alt: 'Chart export' })
    expect(res.created).toBe('2')
    const out = ed.toBytes()
    const sheet = text(out, 'xl/worksheets/sheet2.xml')
    expect(sheet).toMatch(/<pageMargins[^>]*\/><drawing r:id="rId\d+"\/><\/worksheet>/)
    const rels = text(out, 'xl/worksheets/_rels/sheet2.xml.rels')
    expect(rels).toContain('relationships/drawing" Target="../drawings/drawing2.xml"')
    const drels = text(out, 'xl/drawings/_rels/drawing2.xml.rels')
    expect(drels).toContain('relationships/image" Target="../media/image2.png"')
    const ct = text(out, '[Content_Types].xml')
    expect(ct).toContain('PartName="/xl/drawings/drawing2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"')
    expect(ct).toMatch(/PartName="\/xl\/media\/image2\.png" ContentType="image\/png"/)
    expect(files(out)['xl/media/image2.png']).toEqual(png(1280, 720))
    const [pic] = objects(out, 'Other')
    expect(pic).toMatchObject({ kind: 'picture', alt: 'Chart export', name: 'Picture 1' })
    expect(pic!.anchor).toMatchObject({ type: 'twoCell', editAs: 'oneCell', from: { col: 1, row: 1, colOff: 0, rowOff: 0 } })
    // Wider than 640 px: scaled to 640 × 360.
    const wb = openWorkbook(out)
    expect(anchorBox(pic!.anchor!, sheetGeometry(wb.sheet('Other')))).toEqual({ x: 64, y: 20, w: 640, h: 360 })
    expect(text(out, 'xl/drawings/drawing2.xml')).toContain('<a:off x="609600" y="190500"/><a:ext cx="6096000" cy="3429000"/>')
  })

  it('adds to an existing drawing with the next id and leaves the other anchors as written', () => {
    const ed = createSheetEditor(pictureBook())
    const res = ed.apply({ op: 'insert_shape', sheet: 'Pics', geometry: 'roundRect', x: 0, y: 0, width: 120, height: 40, text: 'Hello' })
    expect(res.created).toBe('8')
    const out = ed.toBytes()
    const xml = text(out, 'xl/drawings/drawing1.xml')
    const original = DRAWING_XML.slice(DRAWING_XML.indexOf('<xdr:twoCellAnchor'), DRAWING_XML.lastIndexOf('</xdr:wsDr>'))
    expect(xml).toContain(original)
    const shape = objects(out).find((o) => o.id === '8')!
    expect(shape).toMatchObject({ kind: 'shape', geometry: 'roundRect', fill: '#4472C4', text: 'Hello', textColor: '#FFFFFF' })
    expect(shape.anchor).toMatchObject({ type: 'twoCell', editAs: 'twoCell' })
  })

  it('moves, resizes, renames, describes and rotates; the kind of anchor stays', () => {
    const ed = createSheetEditor(pictureBook())
    ed.apply({ op: 'update_drawing', sheet: 'Pics', id: '2', box: { x: 128, y: 40, w: 100, h: 50 }, alt: 'New logo', name: 'Logo', rotation: 0 })
    ed.apply({ op: 'update_drawing', sheet: 'Pics', id: '4', box: { x: 20, y: 30, w: 40, h: 10 } })
    const out = ed.toBytes()
    const list = objects(out)
    const pic = byName(list, 'Logo')
    expect(pic).toMatchObject({ alt: 'New logo', rotation: 0 })
    expect(pic.anchor).toEqual({
      type: 'twoCell',
      editAs: 'oneCell',
      from: { col: 2, colOff: 0, row: 2, rowOff: 0 },
      to: { col: 3, colOff: 36 * 9525, row: 4, rowOff: 10 * 9525 },
    })
    expect(byName(list, 'TextBox 3').anchor).toEqual({
      type: 'absolute',
      pos: { x: 20 * 9525, y: 30 * 9525 },
      ext: { cx: 40 * 9525, cy: 10 * 9525 },
    })
  })

  it('changes a shape’s text, fill and outline, keeping its paragraph and run formatting', () => {
    const ed = createSheetEditor(pictureBook())
    ed.apply({ op: 'update_drawing', sheet: 'Pics', id: '3', text: 'Q4 target\nopen', fill: '#FF0000', line: null })
    const out = ed.toBytes()
    const rect = byName(objects(out), 'Rectangle 2')
    expect(rect).toMatchObject({ text: 'Q4 target\nopen', fill: '#FF0000', line: null })
    expect(text(out, 'xl/drawings/drawing1.xml')).toContain('<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="1100" b="1"/><a:t>Q4 target</a:t></a:r></a:p>')
    expect(() => ed.apply({ op: 'update_drawing', sheet: 'Pics', id: '2', text: 'x' })).toThrow(/not a shape/)
    expect(() => ed.apply({ op: 'update_drawing', sheet: 'Pics', id: '3', fill: 'red' })).toThrow(/colour/)
  })

  it('deletes an object; its picture goes when nothing else uses it, and undo brings both back', () => {
    const ed = createSheetEditor(pictureBook())
    ed.apply({ op: 'delete_drawing', sheet: 'Pics', id: '2' })
    let out = ed.toBytes()
    expect(objects(out).map((o) => o.id)).toEqual(['3', '4', '5', '6'])
    expect(files(out)['xl/media/image1.png']).toBeUndefined()
    expect(text(out, 'xl/drawings/_rels/drawing1.xml.rels')).not.toContain('image1.png')
    expect(text(out, 'xl/drawings/_rels/drawing1.xml.rels')).toContain('chart1.xml')
    ed.undo()
    out = ed.toBytes()
    expect(objects(out).map((o) => o.id)).toEqual(['2', '3', '4', '5', '6'])
    expect(files(out)['xl/media/image1.png']).toEqual(png(160, 90))
    expect(() => ed.apply({ op: 'delete_drawing', sheet: 'Pics', id: '99' })).toThrow(/no picture or shape with id 99/)
  })

  it('refuses pictures it can’t embed and sizes outside the sheet', () => {
    const ed = createSheetEditor(pictureBook())
    expect(() => ed.apply({ op: 'insert_picture', sheet: 'Pics', image: new Uint8Array([1, 2, 3, 4, 5]), x: 0, y: 0 })).toThrow(/PNG, JPEG, GIF and BMP/)
    expect(() => ed.apply({ op: 'insert_shape', sheet: 'Pics', geometry: 'rect', x: -5, y: 0, width: 10, height: 10 })).toThrow(/left of column A/)
  })
})

describe('drawings move with the cells', () => {
  const anchorsOf = (bytes: Uint8Array) =>
    Object.fromEntries(objects(bytes).map((o) => [o.name, o.anchor]))

  it('inserting rows: two-cell objects move and grow, one-cell ones keep their span, absolute ones stay — no losses asked', () => {
    const ed = createSheetEditor(pictureBook())
    const op = { op: 'insert_rows', sheet: 'Pics', at: 2, count: 2 } as const
    expect(lossesOf(ed.wb, op).map((l) => l.feature)).not.toContain('drawings')
    ed.apply(op)
    const a = anchorsOf(ed.toBytes())
    // Picture 1 (B2:D6, oneCell): starts above the insert, keeps its span.
    expect(a['Picture 1']).toMatchObject({ from: { row: 1 }, to: { row: 5 } })
    // Rectangle (F2:H4, twoCell): its end moves, it grows over the new rows.
    expect(a['Rectangle 2']).toMatchObject({ from: { row: 1 }, to: { row: 5 } })
    expect(a['TextBox 3']).toEqual({ type: 'absolute', pos: { x: 95250, y: 1905000 }, ext: { cx: 952500, cy: 476250 } })
    expect(a['Chart 4']).toMatchObject({ from: { row: 12 }, to: { row: 22 } })
    expect(a['Group 5']).toMatchObject({ type: 'oneCell', from: { row: 1 } })
  })

  it('deleting rows and columns: objects shrink, and collapse onto the cut when all their lines go', () => {
    const ed = createSheetEditor(pictureBook())
    ed.apply({ op: 'delete_rows', sheet: 'Pics', at: 1, count: 3 })
    let a = anchorsOf(ed.toBytes())
    expect(a['Rectangle 2']).toMatchObject({ from: { row: 1, rowOff: 0 }, to: { row: 1, rowOff: 0 } })
    expect(a['Chart 4']).toMatchObject({ from: { row: 7 }, to: { row: 17 } })
    ed.apply({ op: 'delete_columns', sheet: 'Pics', at: 0, count: 1 })
    a = anchorsOf(ed.toBytes())
    expect(a['Chart 4']).toMatchObject({ from: { col: 0 }, to: { col: 5 } })
    expect(a['Group 5']).toMatchObject({ from: { col: 8 } })
  })

  it('a sort moves a picture that sits inside one sorted row, and names larger ones as staying', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: row(1, num('A1', 3)) + row(2, num('A2', 1)) + row(3, num('A3', 2)),
        },
      ],
    })
    const ed = createSheetEditor(bytes)
    // A small picture in B1 (inside row 1) and a tall one over B2:B3.
    ed.apply({ op: 'insert_picture', sheet: 'S', image: png(20, 10), x: 70, y: 2 })
    ed.apply({ op: 'insert_picture', sheet: 'S', image: png(20, 30), x: 70, y: 22 })
    const op = { op: 'sort_range', sheet: 'S', range: 'A1:B3', header: false, keys: [{ col: 0 }] } as const
    expect(lossesOf(ed.wb, op)).toEqual([{ feature: 'drawings', count: 1 }])
    ed.apply(op, { acceptLosses: true })
    const list = objects(ed.toBytes(), 'S')
    expect(list[0]!.anchor).toMatchObject({ from: { row: 2 }, to: { row: 2 } })
    expect(list[1]!.anchor).toMatchObject({ from: { row: 1 } })
  })
})

describe('image formats', () => {
  it('reads the size of PNG, GIF, BMP and JPEG pictures', () => {
    expect(imageInfo(png(3, 4))).toMatchObject({ ext: 'png', width: 3, height: 4 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 0, 6, 0, 0, 0])
    expect(imageInfo(gif)).toMatchObject({ ext: 'gif', width: 5, height: 6 })
    const bmp = new Uint8Array(30)
    bmp.set([0x42, 0x4d])
    new DataView(bmp.buffer).setInt32(18, 7, true)
    new DataView(bmp.buffer).setInt32(22, -8, true)
    expect(imageInfo(bmp)).toMatchObject({ ext: 'bmp', width: 7, height: 8 })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 9, 0, 10, 3, 0, 0, 0])
    expect(imageInfo(jpeg)).toMatchObject({ ext: 'jpeg', width: 10, height: 9 })
  })
})

describe('shapes, chart preservation, shared media and cell images', () => {
  it('creates all preset shape geometries including line and arrow, and edits connector outlines', () => {
    const bytes = buildXlsx({ sheets: [{ name: 'Shapes', rows: row(1, num('A1', 1)) }] })
    const ed = createSheetEditor(bytes)
    SHAPE_GEOMETRIES.forEach((geometry, idx) => {
      ed.apply({
        op: 'insert_shape',
        sheet: 'Shapes',
        geometry,
        x: 10 + idx * 10,
        y: 20,
        width: 50,
        height: 30,
        text: geometry === 'line' || geometry === 'arrow' ? undefined : geometry,
      })
    })
    const out = ed.toBytes()
    const list = objects(out, 'Shapes')
    expect(list).toHaveLength(SHAPE_GEOMETRIES.length)
    for (const geometry of SHAPE_GEOMETRIES) {
      const found = list.find((o) =>
        geometry === 'arrow'
          ? o.geometry === 'line' && o.line?.arrowEnd === true
          : geometry === 'line'
            ? o.geometry === 'line' && !o.line?.arrowEnd
            : o.geometry === geometry && o.text === geometry,
      )
      expect(found, geometry).toBeDefined()
    }
    const lineObj = list.find((o) => o.geometry === 'line' && !o.line?.arrowEnd)!
    ed.apply({ op: 'update_drawing', sheet: 'Shapes', id: lineObj.id, line: '#112233' })
    const updatedLine = objects(ed.toBytes(), 'Shapes').find((o) => o.id === lineObj.id)!
    expect(updatedLine.line?.color).toBe('#112233')

    // Also verifies cxnSp connector outline edits while rejecting fill/text on cxnSp.
    const rawCxn = buildXlsx({
      sheets: [
        {
          name: 'C',
          rows: row(1, num('A1', 1)),
          after: '<drawing r:id="rId1"/>',
          rels: [{ id: 'rId1', type: 'drawing', target: '../drawings/drawing1.xml' }],
        },
      ],
      parts: {
        '/xl/drawings/drawing1.xml': {
          type: 'application/vnd.openxmlformats-officedocument.drawing+xml',
          xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:cxnSp><xdr:nvCxnSpPr><xdr:cNvPr id="2" name="Line 1"/><xdr:cNvCxnSpPr/></xdr:nvCxnSpPr><xdr:spPr><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></xdr:spPr></xdr:cxnSp><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
        },
      },
    })
    const cxnEd = createSheetEditor(rawCxn)
    cxnEd.apply({ op: 'update_drawing', sheet: 'C', id: '2', line: '#FF5500' })
    expect(objects(cxnEd.toBytes(), 'C')[0]!.line?.color).toBe('#FF5500')
    expect(() => cxnEd.apply({ op: 'update_drawing', sheet: 'C', id: '2', text: 'bad' })).toThrow(/not a shape/)
  })

  it('moves and resizes a oneCellAnchor without changing its anchor type, and cleans up empty drawing on delete + undo', () => {
    const ed = createSheetEditor(pictureBook())
    // Group 5 (id="6") is a oneCellAnchor on Pics.
    ed.apply({ op: 'update_drawing', sheet: 'Pics', id: '6', box: { x: 128, y: 60, w: 300, h: 120 } })
    const movedGroup = byName(objects(ed.toBytes(), 'Pics'), 'Group 5')
    expect(movedGroup.anchor).toEqual({
      type: 'oneCell',
      from: { col: 2, colOff: 0, row: 3, rowOff: 0 },
      ext: { cx: 300 * 9525, cy: 120 * 9525 },
    })

    // Deleting the sole object on a sheet removes drawing part, rel and <drawing>, and undo restores all.
    ed.apply({ op: 'insert_shape', sheet: 'Other', geometry: 'rect', x: 10, y: 10, width: 50, height: 30 })
    const insertedId = objects(ed.toBytes(), 'Other')[0]!.id
    ed.apply({ op: 'delete_drawing', sheet: 'Other', id: insertedId })
    let out = ed.toBytes()
    expect(files(out)['xl/drawings/drawing2.xml']).toBeUndefined()
    expect(text(out, 'xl/worksheets/sheet2.xml')).not.toContain('<drawing')
    ed.undo()
    out = ed.toBytes()
    expect(objects(out, 'Other')).toHaveLength(1)
    expect(text(out, 'xl/worksheets/sheet2.xml')).toContain('<drawing')
  })

  it('keeps shared media when deleting one of two pictures pointing to it, and preserves graphicFrame charts on edits & shifts', () => {
    const baseFiles = files(pictureBook())
    // Add a second picture anchor referencing the same rId1 -> /xl/media/image1.png
    const d1 = strFromU8(baseFiles['xl/drawings/drawing1.xml']!)
    const extraPic = `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>6</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="9" name="Picture 8"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`
    baseFiles['xl/drawings/drawing1.xml'] = strToU8(d1.replace('</xdr:wsDr>', `${extraPic}</xdr:wsDr>`))
    const ed = createSheetEditor(zipSync(baseFiles))

    // Deleting Picture 1 (id="2") leaves image1.png intact because Picture 8 still embeds rId1.
    ed.apply({ op: 'delete_drawing', sheet: 'Pics', id: '2' })
    let out = ed.toBytes()
    expect(files(out)['xl/media/image1.png']).toEqual(png(160, 90))
    expect(text(out, 'xl/drawings/_rels/drawing1.xml.rels')).toContain('image1.png')
    // GraphicFrame chart markup and chart1.xml stay untouched.
    const chartFrameXml = DRAWING_XML.slice(DRAWING_XML.indexOf('<xdr:graphicFrame'), DRAWING_XML.indexOf('</xdr:graphicFrame>') + '</xdr:graphicFrame>'.length)
    expect(text(out, 'xl/drawings/drawing1.xml')).toContain(chartFrameXml)
    expect(files(out)['xl/charts/chart1.xml']).toEqual(baseFiles['xl/charts/chart1.xml'])

    // Deleting Picture 8 (id="9") finally removes image1.png while keeping Chart 4 intact.
    ed.apply({ op: 'delete_drawing', sheet: 'Pics', id: '9' })
    out = ed.toBytes()
    expect(files(out)['xl/media/image1.png']).toBeUndefined()
    expect(text(out, 'xl/drawings/drawing1.xml')).toContain(chartFrameXml)

    // Shifting rows moves Chart 4's anchor while preserving its inner <xdr:graphicFrame> untouched.
    ed.apply({ op: 'insert_rows', sheet: 'Pics', at: 1, count: 3 })
    out = ed.toBytes()
    expect(text(out, 'xl/drawings/drawing1.xml')).toContain(chartFrameXml)
    expect(byName(objects(out, 'Pics'), 'Chart 4')).toMatchObject({
      chartPart: '/xl/charts/chart1.xml',
      anchor: { from: { row: 13 }, to: { row: 23 } },
    })
  })

  it('reads Excel IMAGE-in-cell richData pictures (Place in Cell) and keeps richData parts byte for byte', () => {
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
    const baseRich = files(
      buildXlsx({
        sheets: [{ name: 'Cells', rows: row(2, '<c r="C2" t="e" vm="1"><v>#VALUE!</v></c>') }],
        workbookRels: [
          { type: 'sheetMetadata', target: 'metadata.xml' },
          { type: 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue', target: 'richData/rdRichValue.xml' },
          { type: 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure', target: 'richData/rdRichValueStructure.xml' },
          { type: 'http://schemas.microsoft.com/office/2022/10/relationships/richValueRel', target: 'richData/richValueRel.xml' },
        ],
        parts: {
          '/xl/metadata.xml': {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml',
            xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"><metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes><futureMetadata name="XLRICHVALUE" count="1"><bk><extLst><ext uri="{3E2802C4-A4D2-4D8B-9148-E3BE6C30E623}"><xlrd:rvb i="0"/></ext></extLst></bk></futureMetadata><valueMetadata count="1"><bk><rc t="1" v="0"/></bk></valueMetadata></metadata>`,
          },
          '/xl/richData/rdRichValueStructure.xml': {
            type: 'application/vnd.ms-excel.rdrichvaluestructure+xml',
            xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2" count="1"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/><k n="Text" t="s"/></s></rvStructures>`,
          },
          '/xl/richData/rdRichValue.xml': {
            type: 'application/vnd.ms-excel.rdrichvalue+xml',
            xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1"><rv s="0"><v>0</v><v>5</v><v>Product badge</v></rv></rvData>`,
          },
          '/xl/richData/richValueRel.xml': {
            type: 'application/vnd.ms-excel.richvaluerel+xml',
            xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><rel r:id="rId1"/></richValueRels>`,
          },
        },
      }),
    )
    baseRich['[Content_Types].xml'] = strToU8(
      strFromU8(baseRich['[Content_Types].xml']!).replace(
        '<Default Extension="xml"',
        '<Default Extension="png" ContentType="image/png"/><Default Extension="xml"',
      ),
    )
    const before = zipSync({
      ...baseRich,
      'xl/media/cell1.png': png(64, 64),
      'xl/richData/_rels/richValueRel.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}image" Target="../media/cell1.png"/></Relationships>`,
      ),
    })

    const wb = openWorkbook(before)
    expect(readCellImages(wb, wb.requireWorksheet('Cells'))).toEqual([
      { ref: 'C2', row: 1, col: 2, part: '/xl/media/cell1.png', contentType: 'image/png', alt: 'Product badge' },
    ])

    const ed = createSheetEditor(before)
    ed.apply({ op: 'set_cells', sheet: 'Cells', cells: [{ ref: 'A1', value: 'hi' }] })
    const after = ed.toBytes()
    for (const part of [
      'xl/metadata.xml',
      'xl/richData/rdRichValue.xml',
      'xl/richData/rdRichValueStructure.xml',
      'xl/richData/richValueRel.xml',
      'xl/media/cell1.png',
    ]) {
      expect(files(after)[part], part).toEqual(files(before)[part])
    }
  })
})
