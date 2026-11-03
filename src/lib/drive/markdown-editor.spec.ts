// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { renderDriveMarkdown } from '../../../modules/drive/markdown'
import { createMarkdownEditor, type MarkdownEditorHandle } from './markdown-editor'

/**
 * Round-trip safety of the Drive Markdown editor (D2, W-1): what Milkdown
 * loads and serializes back must mean the same thing (identical rendered
 * HTML) and be stable (a second pass changes nothing), so the stored file
 * stays plain Markdown and nothing is lost by opening and saving it.
 */

const open: MarkdownEditorHandle[] = []
afterEach(async () => {
  for (const e of open.splice(0)) await e.destroy()
  document.body.innerHTML = ''
})

async function editor(md: string, onChange?: (m: string) => void) {
  const root = document.createElement('div')
  document.body.append(root)
  const e = await createMarkdownEditor(root, md, { editable: true, onChange })
  open.push(e)
  return e
}

const normalizeHtml = (html: string) => html.replace(/\s+/g, ' ').replace(/> </g, '><').trim()

const CASES: Record<string, string> = {
  headings: '# Title\n\n## Section\n\n### Sub\n\nA paragraph.\n',
  lists: '- one\n- two\n  - nested\n\n1. first\n2. second\n',
  tasks: '- [ ] open task\n- [x] done task\n',
  inline: 'Some **bold**, *italic*, ~~gone~~ and `code` with a [link](https://example.com "Example").\n',
  code: '```ts\nconst x = 1 < 2\n```\n',
  quote: '> quoted line\n>\n> second paragraph\n',
  table: '| Name | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | 5 |\n',
  mixed: '# Kickoff\n\n- **Scope** agreed\n- Budget in the CSV\n\n> Note: see [the brief](https://example.com/brief).\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
  escapes: 'Literal \\*stars\\* and 1\\. not a list, a_b_c.\n',
}

describe('drive markdown editor: round trip', () => {
  for (const [name, md] of Object.entries(CASES)) {
    it(`${name}: same meaning after load → serialize, and stable on a second pass`, async () => {
      const once = (await editor(md)).markdown()
      expect(normalizeHtml(renderDriveMarkdown(once))).toBe(normalizeHtml(renderDriveMarkdown(md)))
      const twice = (await editor(once)).markdown()
      expect(twice).toBe(once)
    })
  }

  it('opening a file is not a change (the serializer may normalize; nothing is reported)', async () => {
    const changes: string[] = []
    const e = await editor('* star bullet\n* second\n', (m) => changes.push(m))
    expect(e.baseline()).toBe(e.markdown())
    await new Promise((r) => setTimeout(r, 300))
    expect(changes).toEqual([])
  })

  it('toolbar actions edit the document and report the new Markdown', async () => {
    const changes: string[] = []
    const e = await editor('hello\n', (m) => changes.push(m))
    e.run('h1')
    expect(e.markdown().trim()).toBe('# hello')
    e.run('paragraph')
    e.run('bullet')
    expect(e.markdown().trim()).toMatch(/^[-*] hello$/)
    e.run('task')
    expect(e.markdown().trim()).toMatch(/^[-*] \[ \] hello$/)
    await new Promise((r) => setTimeout(r, 300))
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.at(-1)).toBe(e.markdown())
  })

  it('load() replaces the document and resets the baseline', async () => {
    const e = await editor('# old\n')
    e.load('# new\n\ntext\n')
    expect(e.markdown()).toContain('# new')
    expect(e.baseline()).toBe(e.markdown())
  })
})
