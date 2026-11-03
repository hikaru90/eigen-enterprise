import { type CmdKey, defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { history, redoCommand, undoCommand } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import {
  commonmark,
  createCodeBlockCommand,
  linkSchema,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark'
import { gfm, insertTableCommand, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { Plugin } from '@milkdown/kit/prose/state'
import { $prose, callCommand, replaceAll } from '@milkdown/kit/utils'

/**
 * The Drive Markdown editor (D2, W-1): WYSIWYG over Markdown with Milkdown —
 * remark parses the stored text into a ProseMirror document and serializes
 * it back, so the file stays plain Markdown (CommonMark + GFM: headings,
 * lists, task lists, links, code, tables, quotes, strikethrough).
 *
 * `baseline` is the editor's own serialization of what it loaded: a change
 * only counts (onChange) when the Markdown differs from it, so opening a
 * file never writes a revision just because the serializer normalizes
 * spacing or bullet characters.
 */

export type MarkdownAction =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'paragraph'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'quote'
  | 'codeblock'
  | 'table'
  | 'undo'
  | 'redo'

export type MarkdownEditorHandle = {
  /** The current document as Markdown. */
  markdown(): string
  /** The Markdown the editor produced for the loaded text (the "nothing changed" point). */
  baseline(): string
  /** Replaces the whole document (restore, takeover reload) and resets the baseline. */
  load(markdown: string): void
  setEditable(editable: boolean): void
  run(action: MarkdownAction): void
  /** Makes the selection a link to `href` (empty href removes the link). */
  link(href: string): void
  focus(): void
  destroy(): Promise<void>
}

const URL_RE = /^(https?:\/\/|mailto:)\S+$/i

/** Pasting a lone URL over selected text links the text (instead of replacing it). */
const pasteLinkOverSelection = $prose(
  (ctx) =>
    new Plugin({
      props: {
        handlePaste(view, event) {
          const text = event.clipboardData?.getData('text/plain')?.trim() ?? ''
          if (!URL_RE.test(text) || view.state.selection.empty) return false
          const { from, to } = view.state.selection
          view.dispatch(view.state.tr.addMark(from, to, linkSchema.type(ctx).create({ href: text })))
          return true
        },
      },
    }),
)

export async function createMarkdownEditor(
  root: HTMLElement,
  initial: string,
  opts: { editable: boolean; onChange?: (markdown: string) => void },
): Promise<MarkdownEditorHandle> {
  let editable = opts.editable
  let base = ''
  let ready = false
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, initial)
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        editable: () => editable,
        attributes: { class: 'drive-md-editor', 'data-testid': 'drive-md-editable', spellcheck: 'true' },
      }))
      ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
        if (ready && md !== base) opts.onChange?.(md)
      })
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(pasteLinkOverSelection)
    .create()

  const serialize = () =>
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      return ctx.get(serializerCtx)(view.state.doc)
    })
  base = serialize()
  ready = true

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each command has its own payload type; the switch below passes the right one
  const call = (cmd: { key: CmdKey<any> }, payload?: unknown) => editor.action(callCommand(cmd.key, payload))

  return {
    markdown: serialize,
    baseline: () => base,
    load(markdown) {
      ready = false
      editor.action(replaceAll(markdown, true))
      base = serialize()
      ready = true
    },
    setEditable(next) {
      editable = next
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.setProps({ editable: () => editable })
      })
    },
    run(action) {
      switch (action) {
        case 'h1':
        case 'h2':
        case 'h3':
          return void call(wrapInHeadingCommand, Number(action.slice(1)))
        case 'paragraph':
          return void call(turnIntoTextCommand)
        case 'bold':
          return void call(toggleStrongCommand)
        case 'italic':
          return void call(toggleEmphasisCommand)
        case 'strike':
          return void call(toggleStrikethroughCommand)
        case 'code':
          return void call(toggleInlineCodeCommand)
        case 'bullet':
          return void call(wrapInBulletListCommand)
        case 'ordered':
          return void call(wrapInOrderedListCommand)
        case 'task':
          return void toggleTask()
        case 'quote':
          return void call(wrapInBlockquoteCommand)
        case 'codeblock':
          return void call(createCodeBlockCommand)
        case 'table':
          return void call(insertTableCommand, { row: 3, col: 3 })
        case 'undo':
          return void call(undoCommand)
        case 'redo':
          return void call(redoCommand)
      }
    },
    link(href) {
      call(toggleLinkCommand, href ? { href } : undefined)
    },
    focus() {
      editor.action((ctx) => ctx.get(editorViewCtx).focus())
    },
    async destroy() {
      await editor.destroy()
    },
  }

  /** A task item is a list item with `checked` set (GFM); wrap in a bullet list first when needed. */
  function toggleTask() {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      let { $from } = view.state.selection
      let depth = findListItem($from)
      if (depth < 0) {
        callCommand(wrapInBulletListCommand.key)(ctx)
        $from = view.state.selection.$from
        depth = findListItem($from)
        if (depth < 0) return
      }
      const node = $from.node(depth)
      const checked = node.attrs.checked
      view.dispatch(view.state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked: checked === null || checked === undefined ? false : null }))
    })
  }
}

function findListItem($from: { depth: number; node(d: number): { type: { name: string } } }): number {
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'list_item') return d
  return -1
}
