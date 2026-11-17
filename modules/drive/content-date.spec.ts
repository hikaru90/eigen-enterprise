import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { contentDateOf, parseExifDate, parsePdfDate } from './content-date'

const blank = () => sharp({ create: { width: 4, height: 4, channels: 3, background: '#888' } })
const latin1 = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))

function pdf(info: string): Uint8Array {
  return latin1(
    [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj',
      `3 0 obj << ${info} >> endobj`,
      'trailer << /Root 1 0 R /Info 3 0 R >>',
      '%%EOF',
    ].join('\n'),
  )
}

describe('drive content date: what a file says about when it is from', () => {
  it('reads when a JPEG photo was taken (EXIF DateTimeOriginal)', async () => {
    const bytes = await blank()
      .jpeg()
      .withExif({ IFD0: { Make: 'Camera' }, IFD2: { DateTimeOriginal: '2019:03:14 09:30:00' } })
      .toBuffer()
    expect(await contentDateOf(new Uint8Array(bytes), 'image/jpeg')).toEqual({
      at: new Date('2019-03-14T09:30:00.000Z'),
      kind: 'taken',
    })
  })

  it('reads EXIF from other image containers too (PNG)', async () => {
    const bytes = await blank()
      .png()
      .withExif({ IFD2: { DateTimeOriginal: '2004:11:02 18:00:00' } })
      .toBuffer()
    expect(await contentDateOf(new Uint8Array(bytes), 'image/png')).toEqual({
      at: new Date('2004-11-02T18:00:00.000Z'),
      kind: 'taken',
    })
  })

  it('falls back to the digitized date when there is no original date', async () => {
    const bytes = await blank()
      .jpeg()
      .withExif({ IFD2: { DateTimeDigitized: '1998:07:01 12:00:00' } })
      .toBuffer()
    expect(await contentDateOf(new Uint8Array(bytes), 'image/jpeg')).toEqual({
      at: new Date('1998-07-01T12:00:00.000Z'),
      kind: 'taken',
    })
  })

  it('knows nothing for an image without EXIF', async () => {
    const bytes = await blank().jpeg().toBuffer()
    expect(await contentDateOf(new Uint8Array(bytes), 'image/jpeg')).toBeNull()
  })

  it('knows nothing for bytes that are not the image they claim to be', async () => {
    expect(await contentDateOf(latin1('not an image'), 'image/jpeg')).toBeNull()
  })

  it('reads a PDF’s creation date from its Info dictionary, as the wall clock it says', async () => {
    const bytes = pdf("/Title (Letter) /CreationDate (D:19870512093000+02'00')")
    expect(await contentDateOf(bytes, 'application/pdf')).toEqual({
      at: new Date('1987-05-12T09:30:00.000Z'),
      kind: 'created',
    })
  })

  it('reads a PDF’s XMP CreateDate when the Info dictionary has none', async () => {
    const bytes = latin1(
      '%PDF-1.7\n<x:xmpmeta><rdf:Description xmp:CreateDate="2011-09-30T14:05:00Z"/></x:xmpmeta>\n%%EOF',
    )
    expect(await contentDateOf(bytes, 'application/pdf')).toEqual({
      at: new Date('2011-09-30T14:05:00.000Z'),
      kind: 'created',
    })
  })

  it('knows nothing for a PDF without a creation date', async () => {
    expect(await contentDateOf(pdf('/Title (Untitled)'), 'application/pdf')).toBeNull()
  })

  it('does not look inside other kinds of files', async () => {
    expect(await contentDateOf(latin1('/CreationDate (D:19870512)'), 'text/plain')).toBeNull()
  })
})

describe('drive content date: the date formats', () => {
  it('parses EXIF dates as the wall clock they are, and refuses blanks and nonsense', () => {
    expect(parseExifDate('2019:03:14 09:30:00')).toEqual(new Date('2019-03-14T09:30:00.000Z'))
    expect(parseExifDate('0000:00:00 00:00:00')).toBeNull()
    expect(parseExifDate('    :  :     :  :  ')).toBeNull()
    expect(parseExifDate('2019:13:40 09:30:00')).toBeNull()
  })

  it('parses PDF dates with and without the optional parts', () => {
    expect(parsePdfDate('D:2019')).toEqual(new Date('2019-01-01T00:00:00.000Z'))
    expect(parsePdfDate('D:201903')).toEqual(new Date('2019-03-01T00:00:00.000Z'))
    expect(parsePdfDate('D:20190314093000Z')).toEqual(new Date('2019-03-14T09:30:00.000Z'))
    expect(parsePdfDate("D:20190314093000-05'00'")).toEqual(new Date('2019-03-14T09:30:00.000Z'))
    // Just after midnight on the 1st stays in its own month whatever the offset.
    expect(parsePdfDate("D:20190401001500+02'00'")).toEqual(new Date('2019-04-01T00:15:00.000Z'))
    expect(parsePdfDate('20190314')).toEqual(new Date('2019-03-14T00:00:00.000Z'))
    expect(parsePdfDate('D:20191340')).toBeNull()
    expect(parsePdfDate('yesterday')).toBeNull()
  })
})
