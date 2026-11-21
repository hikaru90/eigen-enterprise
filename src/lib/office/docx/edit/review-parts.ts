import type { OpcPackage } from '../../ooxml/package'
import { DOMParser } from '@xmldom/xmldom'
import {
  CT_COMMENTS,
  CT_COMMENTS_EX,
  CT_COMMENTS_IDS,
  NS_W14,
  NS_W15,
  NS_W16CID,
  REL_COMMENTS,
  REL_COMMENTS_EX,
  REL_COMMENTS_IDS,
  type CommentData,
  type ParsedComments,
} from '../comments'
import { attr, children, descendants, isEl, NS, REL } from '../xml'
import { setOrdered, setW, writer } from './wml'

/**
 * Writing the review parts while editing: the comments with their thread
 * and id extensions, and settings.xml's track-changes switch. Every write
 * starts from the part as it was opened (or an empty one the first time it
 * is needed): a comment nobody touched is its original element, and a part
 * whose content ends up as it was is written back with its original bytes.
 * A part this session created stays (empty if need be), so its relationship
 * never dangles.
 */

const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const CT_SETTINGS = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

type PartState = {
  part: string | null
  /** The part's bytes and DOM as opened; null when the file had no such part. */
  bytes: Uint8Array | null
  pristine: XMLDocument | null
}

const parse = (xml: string) =>
  new DOMParser().parseFromString(xml, 'application/xml') as unknown as XMLDocument

function opened(pkg: OpcPackage, part: string | null): PartState {
  if (!part) return { part: null, bytes: null, pristine: null }
  return { part, bytes: pkg.bytes(part), pristine: pkg.xml(part).cloneNode(true) as XMLDocument }
}

/** CT_Settings child order (§17.15.1), up to and around w:trackRevisions — enough to place it. */
const SETTINGS_ORDER = [
  'writeProtection',
  'view',
  'zoom',
  'removePersonalInformation',
  'removeDateAndTime',
  'doNotDisplayPageBoundaries',
  'displayBackgroundShape',
  'printPostScriptOverText',
  'printFractionalCharacterWidth',
  'printFormsData',
  'embedTrueTypeFonts',
  'embedSystemFonts',
  'saveSubsetFonts',
  'saveFormsData',
  'mirrorMargins',
  'alignBordersAndEdges',
  'bordersDoNotSurroundHeader',
  'bordersDoNotSurroundFooter',
  'gutterAtTop',
  'hideSpellingErrors',
  'hideGrammaticalErrors',
  'activeWritingStyle',
  'proofState',
  'formsDesign',
  'attachedTemplate',
  'linkStyles',
  'stylePaneFormatFilter',
  'stylePaneSortMethod',
  'documentType',
  'mailMerge',
  'revisionView',
  'trackRevisions',
  'doNotTrackMoves',
  'doNotTrackFormatting',
  'documentProtection',
  'autoFormatOverride',
  'styleLockTheme',
  'styleLockQFSet',
  'defaultTabStop',
  'autoHyphenation',
  'consecutiveHyphenLimit',
  'hyphenationZone',
  'doNotHyphenateCaps',
  'showEnvelope',
  'summaryLength',
  'clickAndTypeStyle',
  'defaultTableStyle',
  'evenAndOddHeaders',
  'bookFoldRevPrinting',
  'bookFoldPrinting',
  'bookFoldPrintingSheets',
  'drawingGridHorizontalSpacing',
  'drawingGridVerticalSpacing',
  'displayHorizontalDrawingGridEvery',
  'displayVerticalDrawingGridEvery',
  'doNotUseMarginsForDrawingGridOrigin',
  'drawingGridHorizontalOrigin',
  'drawingGridVerticalOrigin',
  'doNotShadeFormData',
  'noPunctuationKerning',
  'characterSpacingControl',
  'printTwoOnOne',
  'strictFirstAndLastChars',
  'noLineBreaksAfter',
  'noLineBreaksBefore',
  'savePreviewPicture',
  'doNotValidateAgainstSchema',
  'saveInvalidXml',
  'ignoreMixedContent',
  'alwaysShowPlaceholderText',
  'doNotDemarcateInvalidXml',
  'saveXmlDataOnly',
  'useXSLTWhenSaving',
  'saveThroughXslt',
  'showXMLTags',
  'alwaysMergeEmptyNamespace',
  'updateFields',
  'hdrShapeDefaults',
  'footnotePr',
  'endnotePr',
  'compat',
  'docVars',
  'rsids',
  'attachedSchema',
  'themeFontLang',
  'clrSchemeMapping',
  'doNotIncludeSubdocsInStats',
  'doNotAutoCompressPictures',
  'forceUpgrade',
  'captions',
  'readModeInkLockDown',
  'smartTagType',
  'shapeDefaults',
  'doNotEmbedSmartTags',
  'decimalSymbol',
  'listSeparator',
]

export type ReviewParts = {
  /** Writes the comments (in this order) into the package; parts change only where the comments did. */
  writeComments(list: readonly CommentData[]): void
  /** Writes settings.xml's w:trackRevisions. */
  writeTrackRevisions(on: boolean): void
}

const sameComment = (a: CommentData, b: CommentData) =>
  a.id === b.id &&
  a.author === b.author &&
  a.initials === b.initials &&
  a.date === b.date &&
  a.text === b.text &&
  a.parentId === b.parentId &&
  a.done === b.done &&
  a.paraId === b.paraId &&
  a.durableId === b.durableId

export function reviewParts(opts: {
  pkg: OpcPackage
  mainPart: string
  parsed: ParsedComments
  settingsPart: string | null
  initialTrack: boolean
  hasParagraphStyle(id: string): boolean
  hasCharStyle(id: string): boolean
}): ReviewParts {
  const { pkg, mainPart, parsed } = opts
  const folder = mainPart.slice(0, mainPart.lastIndexOf('/'))
  const comments = opened(pkg, parsed.parts.comments)
  const extended = opened(pkg, parsed.parts.extended)
  const ids = opened(pkg, parsed.parts.ids)
  const settings = opened(pkg, opts.settingsPart)
  const original = new Map(parsed.list.map((c) => [c.id, c]))

  /** The part's name, adding it (with its relationship and content type) the first time. */
  function ensure(state: PartState, base: string, rel: string, ct: string, empty: string): string {
    if (state.part) return state.part
    let name = `${base}.xml`
    for (let n = 2; pkg.has(`${folder}/${name}`); n++) name = `${base}${n}.xml`
    state.part = `${folder}/${name}`
    state.pristine = parse(DECL + empty)
    pkg.setBytes(state.part, new TextEncoder().encode(DECL + empty), ct)
    pkg.addRelationship(mainPart, rel, name)
    return state.part
  }

  const working = (state: PartState) => state.pristine!.cloneNode(true) as XMLDocument

  function commit(state: PartState, doc: XMLDocument, unchanged: boolean) {
    if (unchanged && state.bytes) pkg.setBytes(state.part!, state.bytes)
    else pkg.setXml(state.part!, doc)
  }

  // ------------------------------------------------------------ comments.xml

  function commentElement(doc: XMLDocument, c: CommentData): Element {
    const W = writer(doc)
    const source = parsed.sources.get(c.id)
    const was = original.get(c.id)
    if (
      source &&
      was &&
      was.text === c.text &&
      was.author === c.author &&
      was.initials === c.initials &&
      was.date === c.date
    ) {
      const el = W.copy(source)
      if (c.paraId && c.paraId !== was.paraId) {
        // A comment that now takes part in a thread or is resolved needs its last paragraph's id (what commentsEx keys on).
        const last = descendants(el, NS.w, 'p').at(-1)
        if (last)
          last.setAttributeNS(NS_W14, `${last.lookupPrefix(NS_W14) ?? 'w14'}:paraId`, c.paraId)
      }
      return el
    }
    const el = source ? W.shell(source) : W.w('comment')
    setW(el, 'id', c.id)
    setW(el, 'author', c.author)
    if (c.date) setW(el, 'date', c.date)
    setW(el, 'initials', c.initials)
    const lines = c.text.split('\n')
    lines.forEach((line, i) => {
      const pPr = opts.hasParagraphStyle('CommentText')
        ? [W.w('pPr', {}, [W.w('pStyle', { val: 'CommentText' })])]
        : []
      const kids: Node[] = [...pPr]
      if (i === 0) {
        const rPr = opts.hasCharStyle('CommentReference')
          ? [W.w('rPr', {}, [W.w('rStyle', { val: 'CommentReference' })])]
          : []
        kids.push(W.w('r', {}, [...rPr, W.w('annotationRef')]))
      }
      if (line) {
        const t = W.w('t', {}, [doc.createTextNode(line)])
        if (/^\s|\s$|\s\s/.test(line)) t.setAttributeNS(NS.xml, 'xml:space', 'preserve')
        kids.push(W.w('r', {}, [t]))
      }
      const attrs: Record<string, string | [string, string]> = {}
      if (i === lines.length - 1 && c.paraId) {
        attrs.paraId = [NS_W14, c.paraId]
        attrs.textId = [NS_W14, '77777777']
      }
      el.appendChild(W.el(NS.w, 'p', attrs, kids))
    })
    return el
  }

  function writeCommentsPart(list: readonly CommentData[]) {
    const unchanged =
      list.length === parsed.list.length && list.every((c, i) => sameComment(c, parsed.list[i]!))
    if (unchanged && !comments.part) return
    ensure(
      comments,
      'comments',
      REL_COMMENTS,
      CT_COMMENTS,
      `<w:comments xmlns:w="${NS.w}" xmlns:w14="${NS_W14}" xmlns:mc="${NS_MC}" mc:Ignorable="w14"/>`,
    )
    const doc = working(comments)
    const root = doc.documentElement!
    for (const c of children(root)) if (isEl(c, NS.w, 'comment')) root.removeChild(c)
    for (const c of list) root.appendChild(commentElement(doc, c))
    commit(comments, doc, unchanged)
  }

  // ------------------------------------------------------------ commentsExtended.xml

  function writeExtended(list: readonly CommentData[]) {
    const byId = new Map(list.map((c) => [c.id, c]))
    const unchanged =
      list.length === parsed.list.length && list.every((c, i) => sameComment(c, parsed.list[i]!))
    if (unchanged && !extended.part) return
    // Needed once a comment is new, replies, or is resolved; a file that has the part keeps it in step.
    if (!extended.part && !list.some((c) => !original.has(c.id) || c.parentId !== null || c.done))
      return
    ensure(
      extended,
      'commentsExtended',
      REL_COMMENTS_EX,
      CT_COMMENTS_EX,
      `<w15:commentsEx xmlns:w15="${NS_W15}" xmlns:mc="${NS_MC}" mc:Ignorable="w15"/>`,
    )
    const doc = working(extended)
    const root = doc.documentElement!
    const W = writer(doc)
    const entries = new Map<string, Element>()
    for (const e of descendants(root, NS_W15, 'commentEx')) {
      const pid = (attr(e, NS_W15, 'paraId') ?? '').toUpperCase()
      entries.set(pid, e)
    }
    // Entries of deleted comments go; those of comments that changed get the new values.
    for (const c of parsed.list) {
      if (byId.has(c.id) || !c.paraId) continue
      const e = entries.get(c.paraId.toUpperCase())
      if (e) e.parentNode!.removeChild(e)
    }
    for (const c of list) {
      if (!c.paraId) continue
      const parentPara = c.parentId ? (byId.get(c.parentId)?.paraId ?? null) : null
      const e = entries.get(c.paraId.toUpperCase())
      const was = original.get(c.id)
      if (e && was && was.done === c.done && was.parentId === c.parentId && was.paraId === c.paraId)
        continue
      const el = e ?? W.el(NS_W15, 'commentEx', { paraId: [NS_W15, c.paraId] })
      if (!e) root.appendChild(el)
      if (parentPara)
        el.setAttributeNS(NS_W15, `${el.lookupPrefix(NS_W15) ?? 'w15'}:paraIdParent`, parentPara)
      else if (el.getAttributeNodeNS(NS_W15, 'paraIdParent'))
        el.removeAttributeNS(NS_W15, 'paraIdParent')
      el.setAttributeNS(NS_W15, `${el.lookupPrefix(NS_W15) ?? 'w15'}:done`, c.done ? '1' : '0')
    }
    commit(extended, doc, unchanged)
  }

  // ------------------------------------------------------------ commentsIds.xml

  function writeIds(list: readonly CommentData[]) {
    const unchanged =
      list.length === parsed.list.length && list.every((c, i) => sameComment(c, parsed.list[i]!))
    if (unchanged && !ids.part) return
    if (!ids.part && !list.some((c) => !original.has(c.id) && c.durableId)) return
    ensure(
      ids,
      'commentsIds',
      REL_COMMENTS_IDS,
      CT_COMMENTS_IDS,
      `<w16cid:commentsIds xmlns:w16cid="${NS_W16CID}" xmlns:mc="${NS_MC}" mc:Ignorable="w16cid"/>`,
    )
    const doc = working(ids)
    const root = doc.documentElement!
    const W = writer(doc)
    const keep = new Set(list.map((c) => (c.paraId ?? '').toUpperCase()))
    const present = new Set<string>()
    for (const e of descendants(root, NS_W16CID, 'commentId')) {
      const pid = (attr(e, NS_W16CID, 'paraId') ?? '').toUpperCase()
      const belongs = parsed.list.some((c) => (c.paraId ?? '').toUpperCase() === pid)
      if (belongs && !keep.has(pid)) root.removeChild(e)
      else present.add(pid)
    }
    for (const c of list) {
      if (!c.paraId || !c.durableId || present.has(c.paraId.toUpperCase())) continue
      root.appendChild(
        W.el(NS_W16CID, 'commentId', {
          paraId: [NS_W16CID, c.paraId],
          durableId: [NS_W16CID, c.durableId],
        }),
      )
    }
    commit(ids, doc, unchanged)
  }

  return {
    writeComments(list) {
      writeCommentsPart(list)
      writeExtended(list)
      writeIds(list)
    },
    writeTrackRevisions(on) {
      if (on === opts.initialTrack && !settings.part) return
      ensure(settings, 'settings', REL.settings, CT_SETTINGS, `<w:settings xmlns:w="${NS.w}"/>`)
      const doc = working(settings)
      const root = doc.documentElement!
      for (const c of children(root)) if (isEl(c, NS.w, 'trackRevisions')) root.removeChild(c)
      if (on) setOrdered(root, writer(doc).w('trackRevisions'), SETTINGS_ORDER)
      commit(settings, doc, on === opts.initialTrack)
    },
  }
}
