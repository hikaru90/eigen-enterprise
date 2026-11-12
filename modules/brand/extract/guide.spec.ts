import { describe, expect, it } from 'vitest'
import {
  GUIDE_MAX_BYTES,
  GuideUploadError,
  checkGuideUpload,
  detectGuideMime,
  guideDigest,
} from './guide'

const PDF = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
])
const GIF = new TextEncoder().encode('GIF89a......')
const RIFF_WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])

function sized(prefix: Uint8Array, size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(prefix)
  return bytes
}

describe('detectGuideMime (the format signature, never the file name)', () => {
  it('recognises PDF, PNG, JPEG and WebP', () => {
    expect(detectGuideMime(PDF)).toBe('application/pdf')
    expect(detectGuideMime(PNG)).toBe('image/png')
    expect(detectGuideMime(JPEG)).toBe('image/jpeg')
    expect(detectGuideMime(WEBP)).toBe('image/webp')
  })

  it('refuses everything else, including other RIFF containers and too-short files', () => {
    expect(detectGuideMime(GIF)).toBeNull()
    expect(detectGuideMime(RIFF_WAV)).toBeNull()
    expect(detectGuideMime(new Uint8Array([0x25, 0x50]))).toBeNull()
    expect(detectGuideMime(new Uint8Array())).toBeNull()
  })
})

describe('checkGuideUpload', () => {
  it('accepts a PDF up to the PDF limit and an image up to the image limit', () => {
    expect(
      checkGuideUpload({ filename: 'Kindred CI.pdf', bytes: sized(PDF, GUIDE_MAX_BYTES.pdf) }),
    ).toEqual({
      filename: 'Kindred CI.pdf',
      mime: 'application/pdf',
      sizeBytes: GUIDE_MAX_BYTES.pdf,
    })
    expect(
      checkGuideUpload({ filename: ' logo-sheet.png ', bytes: sized(PNG, GUIDE_MAX_BYTES.image) }),
    ).toEqual({
      filename: 'logo-sheet.png',
      mime: 'image/png',
      sizeBytes: GUIDE_MAX_BYTES.image,
    })
  })

  it('refuses an oversized PDF with a plain sentence (413)', () => {
    const err = (() => {
      try {
        checkGuideUpload({ filename: 'guide.pdf', bytes: sized(PDF, GUIDE_MAX_BYTES.pdf + 1) })
      } catch (e) {
        return e
      }
    })() as GuideUploadError
    expect(err).toBeInstanceOf(GuideUploadError)
    expect(err.code).toBe('too_large')
    expect(err.status).toBe(413)
    expect(err.message).toBe('“guide.pdf” is 10.0 MB; PDFs can be at most 10 MB.')
  })

  it('refuses an oversized image under the image limit, not the PDF one', () => {
    expect(() =>
      checkGuideUpload({ filename: 'board.jpg', bytes: sized(JPEG, GUIDE_MAX_BYTES.image + 1) }),
    ).toThrow('“board.jpg” is 5.0 MB; images can be at most 5 MB.')
  })

  it('refuses other formats (415) and empty files (400)', () => {
    expect(() => checkGuideUpload({ filename: 'anim.gif', bytes: GIF })).toThrow(
      expect.objectContaining({ code: 'unsupported_type', status: 415 }),
    )
    expect(() => checkGuideUpload({ filename: 'anim.gif', bytes: GIF })).toThrow(
      "“anim.gif” isn't a PDF, PNG, JPEG or WebP file. Upload your brand guide in one of those formats.",
    )
    expect(() => checkGuideUpload({ filename: 'empty.pdf', bytes: new Uint8Array() })).toThrow(
      expect.objectContaining({ code: 'empty', status: 400, message: '“empty.pdf” is empty.' }),
    )
  })

  it('a PDF named .png is still a PDF: the bytes decide', () => {
    expect(checkGuideUpload({ filename: 'guide.png', bytes: PDF }).mime).toBe('application/pdf')
  })

  it('requires a file name', () => {
    expect(() => checkGuideUpload({ filename: '   ', bytes: PDF })).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    )
  })
})

describe('guideDigest', () => {
  it('describes the uploaded guide for the session record', () => {
    expect(
      guideDigest({ filename: 'Kindred CI.pdf', mime: 'application/pdf', sizeBytes: 2_500_000 }),
    ).toBe(
      'BRAND GUIDE: “Kindred CI.pdf” (PDF, 2.4 MB). The model reads the guide itself; there is no site capture.',
    )
  })
})
