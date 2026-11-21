import type { DocxEditSession } from './session'
import type { Node as PMNode } from 'prosemirror-model'
import { baseKeymap, chainCommands } from 'prosemirror-commands'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { history, isHistoryTransaction, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { EditorState, Plugin, PluginKey, type Command } from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import { wordDate } from '../comments'
import { ListCounter } from '../numbering'
import { mergeRun } from '../properties'
import { symbolText } from '../symbols'
import { backspaceEndsList, indent, inList, insertNode, insertTab, setAlign, splitParagraph, tableCommands, toggleFormat, toggleVertAlign } from './commands'
import { commentsAt, TRACK_SKIP, trackTransaction, type Reviewer } from './review'
import { effectiveNumbering, partialRunCss, resolvedParagraph, type ParagraphAttrs } from './schema'

/**
 * The Word editor's view (browser only): the session's document in a
 * ProseMirror view with history, Word's usual shortcuts, list labels
 * computed from numbering.xml as decorations, and `onChange` after every
 * change to the document.
 */

const listKey = new PluginKey<DecorationSet>('docx-lists')

/** List labels ("1.", "a)", "•") in front of numbered paragraphs, counted in document order like Word (§17.9). */
export function listLabels(session: DocxEditSession): Plugin<DecorationSet> {
  const build = (doc: PMNode) => {
    const counter = new ListCounter(session.numbering())
    const decos: Decoration[] = []
    doc.descendants((node, pos) => {
      if (node.type.name !== 'paragraph') return true
      const attrs = node.attrs as ParagraphAttrs
      const num = effectiveNumbering(session.display, attrs)
      const label = num ? counter.next(num.numId, num.ilvl) : null
      if (label && label.text !== '' && label.level.format !== 'none') {
        const { props, markRun } = resolvedParagraph(session.display, attrs)
        const marker = mergeRun(markRun, label.level.rPr)
        const shown = label.level.format === 'bullet' ? symbolText(marker.fonts?.ascii, label.text) : { text: label.text, mapped: false }
        const hanging = -(props.indent?.firstLinePt ?? 0)
        const key = `${label.text}|${hanging}|${marker.fonts?.ascii ?? ''}|${marker.sizePt ?? ''}`
        decos.push(
          Decoration.widget(
            pos + 1,
            () => {
              const span = document.createElement('span')
              span.className = 'docx-list-label'
              span.dataset.testid = 'docx-list-label'
              span.contentEditable = 'false'
              span.style.cssText = `${partialRunCss({ ...marker, underline: undefined, strike: undefined }, session.display)};display:inline-block;min-width:${Math.max(hanging, 0)}pt;text-indent:0;text-decoration:none;user-select:none${shown.mapped ? ';font-family:system-ui, sans-serif' : ''}`
              span.textContent = label.level.suffix === 'space' ? `${shown.text} ` : shown.text
              return span
            },
            { side: -1, key, ignoreSelection: true },
          ),
        )
      }
      return false
    })
    return DecorationSet.create(doc, decos)
  }
  return new Plugin<DecorationSet>({
    key: listKey,
    state: {
      init: (_, state) => build(state.doc),
      apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
    },
    props: { decorations: (state) => listKey.getState(state) },
  })
}

type ReviewState = { active: string | null; decos: DecorationSet }
const reviewKey = new PluginKey<ReviewState>('docx-review')
/** Transaction meta: the comment to show as selected (or null). */
export const ACTIVE_COMMENT = 'docx-active-comment'

/**
 * Review decorations: comment ranges highlighted (the selected comment
 * stronger, resolved ones faint) and a change bar beside every paragraph
 * holding a tracked change.
 */
export function reviewDecorations(session: DocxEditSession, onCommentClick?: (id: string) => void): Plugin {
  const build = (doc: PMNode, active: string | null) => {
    const live = new Map(session.liveComments(doc).map((c) => [c.id, c]))
    const decos: Decoration[] = []
    const open: string[] = []
    doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph') {
        const a = node.attrs as ParagraphAttrs
        let changed = !!a.pChange || !!a.markChange
        node.forEach((c) => {
          if (c.marks.some((m) => m.type.name === 'insertion' || m.type.name === 'deletion' || m.type.name === 'formatChange')) changed = true
        })
        if (changed) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'docx-changed' }))
        return true
      }
      if (node.type.name === 'comment_mark') {
        const id = node.attrs.id as string
        if (node.attrs.edge === 'start' && live.has(id)) open.push(id)
        else if (node.attrs.edge === 'end' && open.includes(id)) open.splice(open.indexOf(id), 1)
        return false
      }
      if (node.isInline && open.length > 0) {
        const done = open.every((id) => live.get(id)?.done)
        const cls = `docx-comment${open.includes(active ?? '') ? ' docx-comment-active' : ''}${done ? ' docx-comment-done' : ''}`
        decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: cls, 'data-comments': open.join(' ') }))
      }
      return !node.isInline
    })
    return DecorationSet.create(doc, decos)
  }
  return new Plugin<ReviewState>({
    key: reviewKey,
    state: {
      init: (_, state) => ({ active: null, decos: build(state.doc, null) }),
      apply(tr, old) {
        const meta = tr.getMeta(ACTIVE_COMMENT) as string | null | undefined
        const active = meta === undefined ? old.active : meta
        return tr.docChanged || active !== old.active ? { active, decos: build(tr.doc, active) } : old
      },
    },
    props: {
      decorations: (state) => reviewKey.getState(state)?.decos,
      handleClick(view, pos) {
        const ids = commentsAt(view.state.doc, pos)
        if (ids.length && onCommentClick) onCommentClick(ids.at(-1)!)
        return false
      },
    },
  })
}

export type DocxEditorView = {
  view: EditorView
  run(command: Command): boolean
  setEditable(editable: boolean): void
  /** Shows a comment as selected in the text (null: none). */
  setActiveComment(id: string | null): void
  destroy(): void
}

export function createDocxEditor(
  mount: HTMLElement,
  session: DocxEditSession,
  opts: {
    editable: boolean
    /** Who tracked changes and comments are by; null: unknown, so a tracked document takes no edits. */
    reviewer: Reviewer | null
    onChange?: (doc: PMNode) => void
    onState?: (state: EditorState) => void
    onLink?: () => void
    onCommentClick?: (id: string) => void
    /** An edit was refused: tracking is on and the reviewer is unknown. */
    onRefused?: () => void
  },
): DocxEditorView {
  const m = session.schema.marks
  let editable = opts.editable
  const whenList = (cmd: Command): Command => (state, dispatch, view) => (inList(session, state) ? cmd(state, dispatch, view) : false)
  const keys: Record<string, Command> = {
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
    'Mod-b': toggleFormat(m.bold!),
    'Mod-i': toggleFormat(m.italic!),
    'Mod-u': toggleFormat(m.underline!),
    'Mod-Shift-x': toggleFormat(m.strike!),
    'Mod-=': toggleVertAlign('subscript'),
    'Mod-Shift-=': toggleVertAlign('superscript'),
    'Mod-+': toggleVertAlign('superscript'),
    'Mod-l': setAlign('left'),
    'Mod-e': setAlign('center'),
    'Mod-r': setAlign('right'),
    'Mod-j': setAlign('both'),
    'Mod-k': () => {
      opts.onLink?.()
      return true
    },
    Enter: splitParagraph(session),
    Backspace: backspaceEndsList(session),
    'Shift-Enter': insertNode('hard_break'),
    'Mod-Enter': insertNode('page_break'),
    Tab: chainCommands(tableCommands.nextCell, whenList(indent(session, 1)), insertTab),
    'Shift-Tab': chainCommands(tableCommands.previousCell, whenList(indent(session, -1))),
  }
  const state = EditorState.create({
    doc: session.initial,
    plugins: [history(), keymap(keys), keymap(baseKeymap), dropCursor(), gapCursor(), listLabels(session), reviewDecorations(session, opts.onCommentClick)],
  })
  const view = new EditorView(mount, {
    state,
    editable: () => editable,
    attributes: { class: 'docx-edit-surface', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Document text', spellcheck: 'true' },
    dispatchTransaction(incoming) {
      let tr = incoming
      // With Track changes on, edits are recorded as revisions (undo/redo and review commands are already their own).
      if (tr.docChanged && view.state.doc.attrs.trackRevisions && !tr.getMeta(TRACK_SKIP) && !isHistoryTransaction(tr)) {
        if (!opts.reviewer) {
          opts.onRefused?.()
          return
        }
        tr = trackTransaction(view.state, tr, opts.reviewer, { newId: () => session.newId(), now: () => wordDate(new Date()) })
      }
      const next = view.state.apply(tr)
      view.updateState(next)
      if (tr.docChanged) opts.onChange?.(next.doc)
      opts.onState?.(next)
    },
  })
  return {
    view,
    run: (command) => {
      const ok = command(view.state, view.dispatch, view)
      view.focus()
      return ok
    },
    setEditable(next) {
      editable = next
      view.setProps({ editable: () => editable })
    },
    setActiveComment(id) {
      view.dispatch(view.state.tr.setMeta(ACTIVE_COMMENT, id))
    },
    destroy: () => view.destroy(),
  }
}
