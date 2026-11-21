import { strToU8 } from 'fflate'
import { buildPptx, para, ph, sp, xfrm, type DeckSpec } from './build-pptx'

/**
 * Decks with comments for tests, written from the comment formats: the modern
 * threaded comments (p188 authors + per-slide comment parts) and the legacy
 * ECMA-376 comments (commentAuthors.xml + per-slide p:cmLst).
 */

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
export const P188 = 'http://schemas.microsoft.com/office/powerpoint/2018/8/main'
const PC = 'http://schemas.microsoft.com/office/powerpoint/2013/main/command'
const AC = 'http://schemas.microsoft.com/office/drawing/2013/main/command'
const DECL = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p188="${P188}"`
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
export const REL_MODERN_COMMENTS = 'http://schemas.microsoft.com/office/2018/10/relationships/comments'
export const REL_MODERN_AUTHORS = 'http://schemas.microsoft.com/office/2018/10/relationships/authors'

const body = (...lines: string[]) => `<p188:txBody><a:bodyPr/><a:lstStyle/>${lines.map((l) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${l}</a:t></a:r></a:p>`).join('')}</p188:txBody>`
const sldMk = (sldId: number) => `<pc:docMk/><pc:sldMk cId="1234" sldId="${sldId}"/>`

/** Alice (another provider), and Bob, who is the signed-in member "m-bob" in this app. */
export const AUTHORS =
  `${XML}<p188:authorLst ${DECL}>` +
  `<p188:author id="{A1}" name="Alice Smith" initials="AS" userId="alice@example.com" providerId="AD"/>` +
  `<p188:author id="{B2}" name="Bob Brown" initials="BB" userId="m-bob" providerId="eigenEnterprise"/>` +
  `</p188:authorLst>`

export const BOB = { id: 'm-bob', name: 'Bob Brown' }
export const CAROL = { id: 'm-carol', name: 'Carol Diaz' }

/** Slide 1: a slide comment with two replies, a resolved comment on shape 3, a comment on a range of shape 3's text. */
export const MODERN_SLIDE1 =
  `${XML}<p188:cmLst ${DECL}>` +
  `<p188:cm id="{C1}" authorId="{A1}" created="2026-11-01T09:00:00.000">` +
  `<pc:sldMkLst xmlns:pc="${PC}">${sldMk(256)}</pc:sldMkLst><p188:pos x="914400" y="457200"/>` +
  `<p188:replyLst><p188:reply id="{R1}" authorId="{B2}" created="2026-11-01T10:00:00.000">${body('On it.')}</p188:reply>` +
  `<p188:reply id="{R2}" authorId="{A1}" created="2026-11-01T11:00:00.000">${body('Thanks')}</p188:reply></p188:replyLst>` +
  `${body('Check the numbers', 'before Friday')}</p188:cm>` +
  `<p188:cm id="{C2}" authorId="{B2}" created="2026-11-02T09:00:00.000" status="resolved">` +
  `<ac:deMkLst xmlns:ac="${AC}" xmlns:pc="${PC}">${sldMk(256)}<ac:spMk id="3" creationId="{S3}"/></ac:deMkLst>${body('Bigger box')}</p188:cm>` +
  `<p188:cm id="{C3}" authorId="{B2}" created="2026-11-03T09:00:00.000">` +
  `<ac:txMkLst xmlns:ac="${AC}" xmlns:pc="${PC}">${sldMk(256)}<ac:spMk id="3"/><ac:txMk cp="2" len="4"><ac:context len="6" hash="1"/></ac:txMk></ac:txMkLst>${body('Typo')}</p188:cm>` +
  `</p188:cmLst>`

export const LEGACY_AUTHORS = `${XML}<p:cmAuthorLst ${P}><p:cmAuthor id="0" name="Dana Old" initials="DO" lastIdx="3" clrIdx="0"/></p:cmAuthorLst>`

const P15 = 'http://schemas.microsoft.com/office/powerpoint/2012/main'
/** Two legacy comments, the second a reply to the first (p15 threading). */
export const LEGACY_SLIDE =
  `${XML}<p:cmLst ${P}>` +
  `<p:cm authorId="0" dt="2019-05-01T08:00:00.000" idx="1"><p:pos x="576" y="288"/><p:text>Old remark</p:text></p:cm>` +
  `<p:cm authorId="0" dt="2019-05-02T08:00:00.000" idx="2"><p:pos x="576" y="288"/><p:text>Old reply</p:text>` +
  `<p:extLst><p:ext uri="{C676402C-5697-4E1C-873F-D02D1690AC5C}"><p15:threadingInfo xmlns:p15="${P15}" timeZoneBias="0"><p15:parentCm authorId="0" idx="1"/></p15:threadingInfo></p:ext></p:extLst></p:cm>` +
  `</p:cmLst>`

const CT = 'application/vnd.openxmlformats-officedocument.presentationml'
const title = (t: string) => sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para(t) })
export const BOX = sp({ id: 3, name: 'Box', xfrm: xfrm(952500, 2857500, 2857500, 952500), geom: 'rect', body: para('Hello world') })

/**
 * Slide 1: modern comments (and a legacy part too, which the modern part
 * overrides); slide 2: legacy comments only; slide 3: none.
 */
export function commentedDeck(): DeckSpec {
  return {
    presRels: [
      { id: 'rIdAu', type: REL_MODERN_AUTHORS, target: 'authors.xml' },
      { id: 'rIdLa', type: 'commentAuthors', target: 'commentAuthors.xml' },
    ],
    parts: {
      '/ppt/authors.xml': { bytes: strToU8(AUTHORS), type: 'application/vnd.ms-powerpoint.authors+xml' },
      '/ppt/commentAuthors.xml': { bytes: strToU8(LEGACY_AUTHORS), type: `${CT}.commentAuthors+xml` },
      '/ppt/comments/modernComment_100_1.xml': { bytes: strToU8(MODERN_SLIDE1), type: 'application/vnd.ms-powerpoint.comments+xml' },
      '/ppt/comments/comment1.xml': { bytes: strToU8(LEGACY_SLIDE), type: `${CT}.comments+xml` },
      '/ppt/comments/comment2.xml': { bytes: strToU8(LEGACY_SLIDE), type: `${CT}.comments+xml` },
    },
    slides: [
      {
        shapes: title('First') + BOX,
        rels: [
          { id: 'rIdMc', type: REL_MODERN_COMMENTS, target: '../comments/modernComment_100_1.xml' },
          { id: 'rIdLc', type: 'comments', target: '../comments/comment1.xml' },
        ],
      },
      { shapes: title('Second'), rels: [{ id: 'rIdLc', type: 'comments', target: '../comments/comment2.xml' }] },
      { shapes: title('Third') + BOX },
    ],
  }
}

export const commentedPptx = () => buildPptx(commentedDeck())
