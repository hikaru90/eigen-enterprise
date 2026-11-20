import { strToU8, zipSync, type Zippable } from 'fflate'

/**
 * Builds small .pptx packages for tests, written from scratch as
 * PresentationML (ECMA-376 Part 1 §19): presentation, one master with
 * title/body/footer placeholders and text styles, layouts, slides, notes,
 * a theme, media and table styles. Every part can be overridden.
 */

export const NS_DECL =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const CT = 'application/vnd.openxmlformats-officedocument.presentationml'

export type RelSpec = { id: string; type: string; target: string; external?: boolean }

export type SlideSpec = {
  /** Shapes inside p:spTree (after the group properties). */
  shapes?: string
  /** 1-based layout number (default 1). */
  layout?: number
  /** Speaker notes: plain paragraphs. */
  notes?: string[]
  bg?: string
  clrMapOvr?: string
  hidden?: boolean
  showMasterSp?: boolean
  rels?: RelSpec[]
}

export type LayoutSpec = { name?: string; shapes?: string; showMasterSp?: boolean; bg?: string; clrMapOvr?: string }

export type DeckSpec = {
  size?: { cx: number; cy: number }
  /** Theme part, whole. */
  theme?: string
  master?: { shapes?: string; txStyles?: string; clrMap?: string; bg?: string }
  layouts?: LayoutSpec[]
  slides: SlideSpec[]
  /** Extra parts: name ("/ppt/media/image1.png") → bytes and content type. */
  parts?: Record<string, { bytes: Uint8Array; type: string }>
  tableStyles?: string
  defaultTextStyle?: string
}

export const xfrm = (x: number, y: number, cx: number, cy: number, extra = '') =>
  `<a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`

export const ph = (type: string | null, idx: number | null = null) =>
  `<p:ph${type ? ` type="${type}"` : ''}${idx !== null ? ` idx="${idx}"` : ''}/>`

/** A paragraph: `<a:p>` with an optional whole `<a:pPr …>` element and a whole `<a:rPr …>` for its one run. */
export function para(text: string, opts: { pPr?: string; rPr?: string; end?: string } = {}): string {
  const run = text === '' ? '' : `<a:r>${opts.rPr ?? '<a:rPr lang="en-US"/>'}<a:t>${esc(text)}</a:t></a:r>`
  return `<a:p>${opts.pPr ?? ''}${run}${opts.end ?? ''}</a:p>`
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function sp(o: {
  id: number
  name?: string
  ph?: string
  xfrm?: string
  geom?: string
  spPr?: string
  style?: string
  body?: string
  txBox?: boolean
}): string {
  const geom = o.geom === undefined ? '' : o.geom.startsWith('<') ? o.geom : `<a:prstGeom prst="${o.geom}"><a:avLst/></a:prstGeom>`
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${o.id}" name="${esc(o.name ?? `Shape ${o.id}`)}"/><p:cNvSpPr${o.txBox ? ' txBox="1"' : ''}/><p:nvPr>${o.ph ?? ''}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${o.xfrm ?? ''}${geom}${o.spPr ?? ''}</p:spPr>${o.style ?? ''}` +
    (o.body !== undefined ? `<p:txBody>${o.body.includes('<a:bodyPr') ? '' : '<a:bodyPr/><a:lstStyle/>'}${o.body}</p:txBody>` : '') +
    `</p:sp>`
  )
}

export function pic(o: { id: number; name?: string; rId: string; xfrm: string; crop?: string; descr?: string; nvPr?: string }): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${o.id}" name="${esc(o.name ?? `Picture ${o.id}`)}"${o.descr ? ` descr="${esc(o.descr)}"` : ''}/><p:cNvPicPr/><p:nvPr>${o.nvPr ?? ''}</p:nvPr></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${o.rId}"/>${o.crop ?? ''}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${o.xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  )
}

export function graphicFrame(o: { id: number; name?: string; x: number; y: number; cx: number; cy: number; uri: string; data: string }): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${o.id}" name="${esc(o.name ?? `Frame ${o.id}`)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${o.x}" y="${o.y}"/><a:ext cx="${o.cx}" cy="${o.cy}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="${o.uri}">${o.data}</a:graphicData></a:graphic></p:graphicFrame>`
  )
}

export const TABLE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table'

export const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test">
<a:themeElements>
<a:clrScheme name="Test">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F2A44"/></a:dk2><a:lt2><a:srgbClr val="E8E8E8"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Test"><a:majorFont><a:latin typeface="Major Sans"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Minor Sans"/><a:ea typeface="Minor EA"/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Test">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
<a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>
<a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`

const lvl = (n: number, marL: number, sz: number, extra: string) =>
  `<a:lvl${n}pPr marL="${marL}" indent="-228600" algn="l">${extra}<a:defRPr sz="${sz}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`

export const TX_STYLES =
  `<p:txStyles>` +
  `<p:titleStyle><a:lvl1pPr algn="l"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:buNone/><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
  `<p:bodyStyle>` +
  lvl(1, 228600, 2800, '<a:spcBef><a:spcPts val="1000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/>') +
  lvl(2, 685800, 2400, '<a:spcBef><a:spcPts val="500"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="–"/>') +
  lvl(3, 1143000, 2000, '<a:spcBef><a:spcPts val="500"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/>') +
  `</p:bodyStyle>` +
  `<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle>` +
  `</p:txStyles>`

export const MASTER_SHAPES =
  sp({ id: 2, name: 'Title Placeholder 1', ph: ph('title'), xfrm: xfrm(838200, 365125, 10515600, 1325563), geom: 'rect', body: '<a:bodyPr anchor="ctr"/><a:lstStyle/>' + para('Master title') }) +
  sp({ id: 3, name: 'Text Placeholder 2', ph: ph('body', 1), xfrm: xfrm(838200, 1825625, 10515600, 4351338), geom: 'rect', body: '<a:bodyPr/><a:lstStyle/>' + para('Master text') }) +
  sp({ id: 4, name: 'Date Placeholder 3', ph: ph('dt', 10), xfrm: xfrm(838200, 6356350, 2743200, 365125), geom: 'rect', body: '<a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle>' + para('') }) +
  sp({ id: 5, name: 'Slide Number Placeholder 4', ph: ph('sldNum', 12), xfrm: xfrm(8610600, 6356350, 2743200, 365125), geom: 'rect', body: '<a:bodyPr/><a:lstStyle><a:lvl1pPr algn="r"><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle><a:p><a:fld id="{1}" type="slidenum"><a:t>‹#›</a:t></a:fld></a:p>' })

export const DEFAULT_LAYOUTS: LayoutSpec[] = [
  { name: 'Title and Content', shapes: sp({ id: 2, name: 'Title 1', ph: ph('title') }) + sp({ id: 3, name: 'Content Placeholder 2', ph: ph(null, 1) }) },
  {
    name: 'Title Slide',
    shapes:
      sp({ id: 2, name: 'Title 1', ph: ph('ctrTitle'), xfrm: xfrm(1524000, 1122363, 9144000, 2387600), body: '<a:bodyPr anchor="b"/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="6000"/></a:lvl1pPr></a:lstStyle>' + para('') }) +
      sp({ id: 3, name: 'Subtitle 2', ph: ph('subTitle', 1), xfrm: xfrm(1524000, 3602038, 9144000, 1655762), body: '<a:bodyPr/><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle>' + para('') }),
  },
]

const tree = (shapes: string) =>
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree>`

const rels = (list: RelSpec[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type.startsWith('http') ? r.type : REL + r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

export function buildPptx(spec: DeckSpec): Uint8Array {
  const size = spec.size ?? { cx: 12192000, cy: 6858000 }
  const layouts = spec.layouts ?? DEFAULT_LAYOUTS
  const files: Zippable = {}
  const overrides: Array<[string, string]> = []
  const put = (name: string, text: string, type?: string) => {
    files[name] = strToU8(text)
    if (type) overrides.push([`/${name}`, type])
  }

  const presRels: RelSpec[] = [{ id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }]
  spec.slides.forEach((_, i) => presRels.push({ id: `rId${i + 10}`, type: 'slide', target: `slides/slide${i + 1}.xml` }))
  presRels.push({ id: 'rId2', type: 'theme', target: 'theme/theme1.xml' })
  if (spec.tableStyles) presRels.push({ id: 'rId3', type: 'tableStyles', target: 'tableStyles.xml' })

  put(
    'ppt/presentation.xml',
    `${XML}<p:presentation ${NS_DECL}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${spec.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`).join('')}</p:sldIdLst>` +
      `<p:sldSz cx="${size.cx}" cy="${size.cy}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      (spec.defaultTextStyle ?? '<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0"><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle>') +
      `</p:presentation>`,
    `${CT}.presentation.main+xml`,
  )
  put('ppt/_rels/presentation.xml.rels', rels(presRels))
  put('ppt/theme/theme1.xml', spec.theme ?? THEME, 'application/vnd.openxmlformats-officedocument.theme+xml')
  if (spec.tableStyles) put('ppt/tableStyles.xml', spec.tableStyles, `${CT}.tableStyles+xml`)

  const m = spec.master ?? {}
  put(
    'ppt/slideMasters/slideMaster1.xml',
    `${XML}<p:sldMaster ${NS_DECL}><p:cSld>${m.bg ?? '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'}${tree(m.shapes ?? MASTER_SHAPES)}</p:cSld>${m.clrMap ?? CLR_MAP}` +
      `<p:sldLayoutIdLst>${layouts.map((_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldLayoutIdLst>${m.txStyles ?? TX_STYLES}</p:sldMaster>`,
    `${CT}.slideMaster+xml`,
  )
  put(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels([...layouts.map((_, i) => ({ id: `rId${i + 1}`, type: 'slideLayout', target: `../slideLayouts/slideLayout${i + 1}.xml` })), { id: 'rId99', type: 'theme', target: '../theme/theme1.xml' }]),
  )
  layouts.forEach((l, i) => {
    put(
      `ppt/slideLayouts/slideLayout${i + 1}.xml`,
      `${XML}<p:sldLayout ${NS_DECL}${l.showMasterSp === false ? ' showMasterSp="0"' : ''}><p:cSld name="${esc(l.name ?? `Layout ${i + 1}`)}">${l.bg ?? ''}${tree(l.shapes ?? '')}</p:cSld>${l.clrMapOvr ?? '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'}</p:sldLayout>`,
      `${CT}.slideLayout+xml`,
    )
    put(`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]))
  })

  spec.slides.forEach((s, i) => {
    const n = i + 1
    const sRels: RelSpec[] = [{ id: 'rId1', type: 'slideLayout', target: `../slideLayouts/slideLayout${s.layout ?? 1}.xml` }, ...(s.rels ?? [])]
    if (s.notes) {
      sRels.push({ id: 'rIdNotes', type: 'notesSlide', target: `../notesSlides/notesSlide${n}.xml` })
      put(
        `ppt/notesSlides/notesSlide${n}.xml`,
        `${XML}<p:notes ${NS_DECL}><p:cSld>${tree(
          sp({ id: 2, name: 'Slide Image Placeholder 1', ph: ph('sldImg') }) +
            sp({ id: 3, name: 'Notes Placeholder 2', ph: ph('body', 1), body: s.notes.map((t) => para(t)).join('') }),
        )}</p:cSld></p:notes>`,
        `${CT}.notesSlide+xml`,
      )
      put(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, rels([{ id: 'rId1', type: 'slide', target: `../slides/slide${n}.xml` }]))
    }
    put(
      `ppt/slides/slide${n}.xml`,
      `${XML}<p:sld ${NS_DECL}${s.hidden ? ' show="0"' : ''}${s.showMasterSp === false ? ' showMasterSp="0"' : ''}><p:cSld>${s.bg ?? ''}${tree(s.shapes ?? '')}</p:cSld>${s.clrMapOvr ?? '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'}</p:sld>`,
      `${CT}.slide+xml`,
    )
    put(`ppt/slides/_rels/slide${n}.xml.rels`, rels(sRels))
  })

  for (const [name, { bytes, type }] of Object.entries(spec.parts ?? {})) {
    files[name.replace(/^\//, '')] = bytes
    overrides.push([name, type])
  }

  put('_rels/.rels', rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]))
  const types =
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    overrides.map(([n, t]) => `<Override PartName="${n}" ContentType="${t}"/>`).join('') +
    `</Types>`
  return zipSync({ '[Content_Types].xml': strToU8(types), ...files })
}

/** A 1×1 PNG (a red pixel), for picture tests. */
export const PNG_1PX = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)
