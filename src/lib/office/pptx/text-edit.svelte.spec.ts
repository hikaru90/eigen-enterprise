import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { readPackage } from '../ooxml/package'
import { createDeckEditor } from './editor'
import type { SpNode } from './model'
import { renderSlideSvg } from './render'
import { resolveSlide } from './resolve'
import { buildPptx, para, sp, xfrm } from './test-utils/build-pptx'
import { charPosOf, readParagraphs, runPosOf, selectChars, selectionIn, textContainer } from './text-edit'

const S1 = '/ppt/slides/slide1.xml'
const BODY =
  '<a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>Hello </a:t></a:r><a:r><a:rPr lang="en-US"/><a:t>world</a:t></a:r></a:p>' +
  para('Second line') +
  '<a:p><a:endParaRPr lang="en-US"/></a:p>'

function setup() {
  const ed = createDeckEditor(readPackage(buildPptx({ slides: [{ shapes: sp({ id: 4, name: 'Text', xfrm: xfrm(0, 0, 6000000, 3000000), body: BODY }) }] })))
  const host = document.createElement('div')
  host.style.width = '640px'
  document.body.appendChild(host)
  const draw = () => {
    host.innerHTML = renderSlideSvg(resolveSlide(ed.deck(), 0, { editing: true }), { idPrefix: 't', media: () => null })
    const root = textContainer(host.querySelector('[data-sid="4"] .pptx-text')!)!
    root.contentEditable = 'true'
    return root
  }
  return { ed, host, draw }
}

const paragraphs = (ed: ReturnType<typeof setup>['ed']) => (ed.deck().slides[0]!.shapes[0] as SpNode).text!.paragraphs
const texts = (ed: ReturnType<typeof setup>['ed']) => paragraphs(ed).map((p) => p.runs.map((r) => (r.kind === 'break' ? '\n' : r.text)).join(''))

afterEach(() => {
  document.body.innerHTML = ''
})

describe('editing slide text in place', () => {
  it('reads an untouched text box back as its own runs: committing changes nothing', () => {
    const { ed, draw } = setup()
    const root = draw()
    const edits = readParagraphs(root)
    expect(edits).toEqual([
      {
        from: 0,
        runs: [
          { kind: 'text', text: 'Hello ', from: { p: 0, r: 0 } },
          { kind: 'text', text: 'world', from: { p: 0, r: 1 } },
        ],
      },
      { from: 1, runs: [{ kind: 'text', text: 'Second line', from: { p: 1, r: 0 } }] },
      { from: 2, runs: [] },
    ])
    expect(ed.apply({ kind: 'setText', slide: S1, shape: '4', paragraphs: edits })).toBeNull()
  })

  it('typing keeps the formatting of the run typed into; Enter splits the paragraph', async () => {
    const { ed, draw } = setup()
    const root = draw()
    root.focus()
    selectChars(root, { p: 0, c: 5 }, { p: 0, c: 5 })
    await userEvent.keyboard('!!')
    selectChars(root, { p: 1, c: 6 }, { p: 1, c: 6 })
    await userEvent.keyboard('{Enter}')
    // the empty third paragraph gets text too
    selectChars(root, { p: 3, c: 0 }, { p: 3, c: 0 })
    await userEvent.keyboard('End')
    ed.apply({ kind: 'setText', slide: S1, shape: '4', paragraphs: readParagraphs(root) })
    expect(texts(ed)).toEqual(['Hello!! world', 'Second', ' line', 'End'])
    const ps = paragraphs(ed)
    expect(ps[0]!.runs.map((r) => r.props.bold ?? false)).toEqual([true, false])
  })

  it('maps the selection to character positions and back to run positions', async () => {
    const { ed, draw } = setup()
    const root = draw()
    root.focus()
    selectChars(root, { p: 0, c: 3 }, { p: 1, c: 2 })
    expect(selectionIn(root)).toEqual({ start: { p: 0, c: 3 }, end: { p: 1, c: 2 } })
    const word = root.querySelector('[data-r="1"]')!.firstChild!
    expect(charPosOf(root, word, 2)).toEqual({ p: 0, c: 8 })
    const ps = paragraphs(ed)
    expect(runPosOf(ps, { p: 0, c: 8 }, 1)).toEqual({ p: 0, r: 1, o: 2 })
    expect(runPosOf(ps, { p: 0, c: 3 }, 1)).toEqual({ p: 0, r: 0, o: 3 })
    expect(runPosOf(ps, { p: 0, c: 11 }, 1)).toEqual({ p: 0, r: 1, o: 5 })
    expect(runPosOf(ps, { p: 2, c: 0 }, 1)).toEqual({ p: 2, r: 0, o: 0 })
  })

  it('a caret in an empty paragraph stays in it', () => {
    const { draw } = setup()
    const root = draw()
    root.focus()
    selectChars(root, { p: 2, c: 0 }, { p: 2, c: 0 })
    expect(selectionIn(root)).toEqual({ start: { p: 2, c: 0 }, end: { p: 2, c: 0 } })
  })
})
