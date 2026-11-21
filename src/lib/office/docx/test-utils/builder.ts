import { strToU8, zipSync, type Zippable } from 'fflate'

/**
 * Builds small .docx packages for tests, written by hand from ECMA-376
 * (Part 1 WordprocessingML, Part 2 OPC). Tests pass WordprocessingML
 * snippets; the builder adds the namespaces, parts, content types and
 * relationships around them.
 */

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XMLNS = [
  `xmlns:w="${W_NS}"`,
  `xmlns:r="${R_NS}"`,
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
].join(' ')

export type DocxSpec = {
  /** Inner XML of w:body (paragraphs, tables, the final w:sectPr). */
  body: string
  /** Inner XML of w:styles. */
  styles?: string
  /** Inner XML of w:numbering. */
  numbering?: string
  /** Inner XML of w:settings. */
  settings?: string
  /** Inner XML of w:fonts. */
  fonts?: string
  /** a:fontScheme XML for the theme part. */
  fontScheme?: string
  /** Header parts: relationship id → inner XML of w:hdr. */
  headers?: Record<string, string>
  /** Footer parts: relationship id → inner XML of w:ftr. */
  footers?: Record<string, string>
  /** Inner XML of w:footnotes (w:footnote elements). */
  footnotes?: string
  /** Inner XML of w:endnotes. */
  endnotes?: string
  /** Inner XML of w:comments. */
  comments?: string
  /** Media parts: relationship id → { name under word/media/, bytes }. */
  media?: Record<string, { name: string; bytes: Uint8Array }>
  /** External hyperlinks: relationship id → URL. */
  links?: Record<string, string>
  /** Extra internal parts the document points at: relationship id → { type (last URI segment, or a full URI), target, xml }. */
  parts?: Record<string, { type: string; target: string; xml: string; contentType: string }>
}

const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** A 1×1 PNG (transparent), for image tests. */
export const PNG_1PX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

export function buildDocx(spec: DocxSpec): Uint8Array {
  const files: Zippable = {}
  const overrides: string[] = []
  const rels: string[] = []
  const rel = (id: string, type: string, target: string, external = false) =>
    rels.push(
      `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${REL}/${type}`}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`,
    )
  const part = (path: string, ct: string, xml: string) => {
    files[path] = strToU8(decl + xml)
    overrides.push(`<Override PartName="/${path}" ContentType="${ct}"/>`)
  }
  const ML = 'application/vnd.openxmlformats-officedocument.wordprocessingml'

  part('word/document.xml', `${ML}.document.main+xml`, `<w:document ${XMLNS}><w:body>${spec.body}</w:body></w:document>`)
  if (spec.styles !== undefined) {
    part('word/styles.xml', `${ML}.styles+xml`, `<w:styles ${XMLNS}>${spec.styles}</w:styles>`)
    rel('rIdStyles', 'styles', 'styles.xml')
  }
  if (spec.numbering !== undefined) {
    part('word/numbering.xml', `${ML}.numbering+xml`, `<w:numbering ${XMLNS}>${spec.numbering}</w:numbering>`)
    rel('rIdNumbering', 'numbering', 'numbering.xml')
  }
  if (spec.settings !== undefined) {
    part('word/settings.xml', `${ML}.settings+xml`, `<w:settings ${XMLNS}>${spec.settings}</w:settings>`)
    rel('rIdSettings', 'settings', 'settings.xml')
  }
  if (spec.fonts !== undefined) {
    part('word/fontTable.xml', `${ML}.fontTable+xml`, `<w:fonts ${XMLNS}>${spec.fonts}</w:fonts>`)
    rel('rIdFonts', 'fontTable', 'fontTable.xml')
  }
  if (spec.fontScheme !== undefined) {
    part(
      'word/theme/theme1.xml',
      'application/vnd.openxmlformats-officedocument.theme+xml',
      `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements>${spec.fontScheme}</a:themeElements></a:theme>`,
    )
    rel('rIdTheme', 'theme', 'theme/theme1.xml')
  }
  for (const [id, xml] of Object.entries(spec.headers ?? {})) {
    part(`word/header-${id}.xml`, `${ML}.header+xml`, `<w:hdr ${XMLNS}>${xml}</w:hdr>`)
    rel(id, 'header', `header-${id}.xml`)
  }
  for (const [id, xml] of Object.entries(spec.footers ?? {})) {
    part(`word/footer-${id}.xml`, `${ML}.footer+xml`, `<w:ftr ${XMLNS}>${xml}</w:ftr>`)
    rel(id, 'footer', `footer-${id}.xml`)
  }
  if (spec.footnotes !== undefined) {
    part('word/footnotes.xml', `${ML}.footnotes+xml`, `<w:footnotes ${XMLNS}>${spec.footnotes}</w:footnotes>`)
    rel('rIdFootnotes', 'footnotes', 'footnotes.xml')
  }
  if (spec.endnotes !== undefined) {
    part('word/endnotes.xml', `${ML}.endnotes+xml`, `<w:endnotes ${XMLNS}>${spec.endnotes}</w:endnotes>`)
    rel('rIdEndnotes', 'endnotes', 'endnotes.xml')
  }
  if (spec.comments !== undefined) {
    part('word/comments.xml', `${ML}.comments+xml`, `<w:comments ${XMLNS}>${spec.comments}</w:comments>`)
    rel('rIdComments', 'comments', 'comments.xml')
  }
  for (const [id, m] of Object.entries(spec.media ?? {})) {
    files[`word/media/${m.name}`] = m.bytes
    rel(id, 'image', `media/${m.name}`)
  }
  for (const [id, url] of Object.entries(spec.links ?? {})) rel(id, 'hyperlink', url, true)
  for (const [id, p] of Object.entries(spec.parts ?? {})) {
    part(`word/${p.target}`, p.contentType, p.xml)
    rel(id, p.type, p.target)
  }

  const out: Zippable = {
    '[Content_Types].xml': strToU8(
      decl +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Default Extension="png" ContentType="image/png"/>` +
        `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
        overrides.join('') +
        `</Types>`,
    ),
    '_rels/.rels': strToU8(
      decl +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    'word/_rels/document.xml.rels': strToU8(
      decl + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
    ),
    ...files,
  }
  return zipSync(out)
}

/** `<w:p>` with optional pPr inner XML and runs. */
export const p = (runs: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`
/** `<w:r>` with optional rPr inner XML and text. */
export const r = (text: string, rPr = '') =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`

/** A final section: A4-ish page in twips with 1" margins unless given. */
export const sectPr = (inner = '') =>
  `<w:sectPr>${inner || '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>'}</w:sectPr>`

/** An inline picture of `cx`×`cy` EMUs pointing at relationship `rid`. */
export const inlineImage = (rid: string, cx: number, cy: number, descr = '', title = '') =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Picture 1" descr="${descr}"${title ? ` title="${title}"` : ''}/>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="p"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic>` +
  `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
