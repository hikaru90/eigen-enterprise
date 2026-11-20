import type { Slide } from '../types'
import { strToU8, zipSync } from 'fflate'

/**
 * A small, valid PowerPoint deck (ECMA-376 PresentationML): presentation,
 * one master, one layout, a theme and one slide per entry, each slide a
 * title shape and a bullet body. Deterministic (fixed zip mtime) so a reset
 * reseeds byte-identical files.
 */

const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument.presentationml'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const rels = (entries: Array<[id: string, type: string, target: string]>) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`

const spTree = (shapes: string) =>
  `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld>`

const shape = (id: number, name: string, ph: string, paragraphs: string[]) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr><p:ph type="${ph}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs
    .map((t) => `<a:p><a:r><a:rPr lang="en-GB"/><a:t>${esc(t)}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp>`

const slideXml = (s: Slide) =>
  `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">${spTree(shape(2, 'Title', 'title', [s.title]) + shape(3, 'Body', 'body', s.bullets))}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`

const MASTER = `${XML}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">${spTree('')}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`
const LAYOUT = `${XML}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="obj">${spTree('')}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`

const sysColor = (name: string, rgb: string) => `<a:${name}><a:srgbClr val="${rgb}"/></a:${name}>`
const THEME = `${XML}<a:theme xmlns:a="${NS_A}" name="Fjordlight"><a:themeElements><a:clrScheme name="Fjordlight">${[
  ['dk1', '000000'],
  ['lt1', 'FFFFFF'],
  ['dk2', '1F4E79'],
  ['lt2', 'EEF2F6'],
  ['accent1', '1F4E79'],
  ['accent2', 'F2A93B'],
  ['accent3', '5B8DB8'],
  ['accent4', '8FB3D9'],
  ['accent5', 'C9D7E6'],
  ['accent6', '6B6B6B'],
  ['hlink', '1F4E79'],
  ['folHlink', '5B8DB8'],
]
  .map(([n, v]) => sysColor(n!, v!))
  .join('')}</a:clrScheme><a:fontScheme name="Fjordlight"><a:majorFont><a:latin typeface="Inter"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Inter"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Fjordlight"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

/** Fixed zip entry time: same slides → same bytes. */
const MTIME = new Date('2026-01-01T00:00:00Z')

export function buildPptx(slides: Slide[]): Uint8Array {
  if (slides.length === 0) throw new Error('a deck needs at least one slide')
  const n = slides.length
  const files: Record<string, string> = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides
      .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}.slide+xml"/>`)
      .join('')}</Types>`,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides
      .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`)
      .join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'theme', 'theme/theme1.xml'],
      ...Array.from({ length: n }, (_, i): [string, string, string] => [`rId${i + 3}`, 'slide', `slides/slide${i + 1}.xml`]),
    ]),
    'ppt/slideMasters/slideMaster1.xml': MASTER,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml'],
    ]),
    'ppt/slideLayouts/slideLayout1.xml': LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/theme/theme1.xml': THEME,
  }
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = slideXml(s)
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']])
  })
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, [strToU8(text), { mtime: MTIME }]])))
}
