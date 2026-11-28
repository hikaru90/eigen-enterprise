import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deckSlides } from './artifact'
import { memoryEditLockStore } from './locks'
import { ARTIFACT_TOOL_NAMES, ARTIFACT_WRITE_TOOLS, DRIVE_TOOL_NAMES, driveManifest } from './manifest'
import { memoryDriveAccess } from './memory-access'
import { createDriveService } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'
import { createDriveTools } from './tools'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-tools-'))
  dirs.push(dir)
  const access = memoryDriveAccess({ users: { alice: { role: 'member' }, bob: { role: 'member' } } })
  const drive = createDriveService({ store: memoryDriveStore(), blobs: diskBlobStore(dir, Buffer.alloc(32, 7)), access, maxUploadBytes: 4 << 20, locks: memoryEditLockStore() })
  const pdf = vi.fn(async () => Buffer.from('%PDF-1.7 fake'))
  const setContent = vi.fn(async () => {})
  const tools = createDriveTools({
    service: async () => drive,
    viewUrl: async (s) => `/api/drive/view/TOKEN-${s.userId}/${s.fileName}`,
    pdfDeps: {
      browser: { executablePath: () => '/bin/chrome', isExecutable: async () => true },
      launch: async () => ({ newPage: async () => ({ route: async () => {}, setContent, pdf }), close: async () => {} }),
    },
  })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const human = (id: string) => ({ principal: { id, kind: 'human' as const, roles: ['member'] }, requestId: 'r' })
  const agent = { principal: { id: 'agent:1', kind: 'agent' as const, roles: ['agent'] }, requestId: 'r' }
  return { drive, tool, human, agent, setContent }
}

type Out = { artifact: { id: string; name: string; kind: string; slideCount: number | null } }

describe('artifacts.* tools', () => {
  it('are drive tools in their own namespace; the writes wait on approval', async () => {
    const { tool } = await setup()
    expect(driveManifest.toolNamespaces).toContain('artifacts')
    for (const n of ARTIFACT_TOOL_NAMES) expect(DRIVE_TOOL_NAMES).toContain(n)
    expect(ARTIFACT_WRITE_TOOLS).not.toContain('artifacts.read')
    expect(tool('artifacts.create')).toMatchObject({ module: 'drive', auditClass: 'mutate', approvalRisk: 'internal' })
    expect(tool('artifacts.read').auditClass).toBe('read')
  })

  it('creates a deck from html and markdown slides, in the person’s drive', async () => {
    const { tool, human, drive } = await setup()
    const out = (await tool('artifacts.create').handler(human('alice'), {
      kind: 'deck',
      name: 'Pitch',
      css: '.big{font-size:120px}',
      slides: [{ html: '<h1 class="big">Acme</h1>' }, { markdown: '# Problem\n\n- slow' }],
    })) as Out
    expect(out.artifact).toMatchObject({ name: 'Pitch.deck.html', kind: 'deck', slideCount: 2 })
    const { content } = await drive.readText({ kind: 'user', userId: 'alice' }, out.artifact.id)
    expect(deckSlides(content)[1]).toContain('<h1>Problem</h1>')
    await expect(tool('artifacts.read').handler(human('bob'), { file_id: out.artifact.id })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('updates whole, by find/replace and by slide, each a revision', async () => {
    const { tool, human, drive } = await setup()
    const ctx = human('alice')
    const { artifact } = (await tool('artifacts.create').handler(ctx, { kind: 'deck', name: 'D', slides: [{ html: '<p>a</p>' }] })) as Out
    await tool('artifacts.update').handler(ctx, { file_id: artifact.id, slide_ops: [{ op: 'insert', index: 1, slide: { html: '<p>b</p>' } }] })
    await tool('artifacts.update').handler(ctx, { file_id: artifact.id, edits: [{ find: '<p>b</p>', replace: '<p>B</p>' }] })
    const read = (await tool('artifacts.read').handler(ctx, { file_id: artifact.id })) as { slides: Array<{ index: number; html: string }> }
    expect(read.slides).toEqual([{ index: 0, html: '<p>a</p>' }, { index: 1, html: '<p>B</p>' }])
    expect((await drive.listRevisions({ kind: 'user', userId: 'alice' }, artifact.id)).length).toBeGreaterThanOrEqual(3)
    const page = (await tool('artifacts.create').handler(ctx, { kind: 'page', name: 'One pager', content: '<h1>Hi</h1>' })) as Out
    expect(page.artifact).toMatchObject({ name: 'One pager.html', kind: 'page', slideCount: null })
    await tool('artifacts.update').handler(ctx, { file_id: page.artifact.id, content: '<h1>Hello</h1>' })
    expect(((await tool('artifacts.read').handler(ctx, { file_id: page.artifact.id })) as { content: string }).content).toBe('<h1>Hello</h1>')
  })

  it('refuses ambiguous updates, slide ops on a page and non-artifacts', async () => {
    const { tool, human, drive } = await setup()
    const ctx = human('alice')
    const page = (await tool('artifacts.create').handler(ctx, { kind: 'page', name: 'P', content: 'x x' })) as Out
    await expect(tool('artifacts.update').handler(ctx, { file_id: page.artifact.id, content: 'a', edits: [{ find: 'x', replace: 'y' }] })).rejects.toThrow(/exactly one/)
    await expect(tool('artifacts.update').handler(ctx, { file_id: page.artifact.id, edits: [{ find: 'x', replace: 'y' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(tool('artifacts.update').handler(ctx, { file_id: page.artifact.id, slide_ops: [{ op: 'delete', index: 0 }] })).rejects.toThrow(/is a page, not a deck/)
    const md = await drive.createDocument({ kind: 'user', userId: 'alice' }, null, 'md', 'notes')
    await expect(tool('artifacts.read').handler(ctx, { file_id: md.id })).rejects.toThrow(/not an artifact/)
  })

  it('gives a person, never an agent, the sandboxed view address', async () => {
    const { tool, human, agent } = await setup()
    const { artifact } = (await tool('artifacts.create').handler(human('alice'), { kind: 'page', name: 'P', content: '<p>x</p>' })) as Out
    const read = (await tool('artifacts.read').handler(human('alice'), { file_id: artifact.id, view_url: true })) as { viewUrl: string }
    expect(read.viewUrl).toMatch(/^\/api\/drive\/view\/TOKEN-alice\/P\.html\?v=[0-9a-f]{12}$/)
    await expect(tool('artifacts.read').handler(agent, { file_id: artifact.id, view_url: true })).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('exports a deck to a PDF next to it, rendered from its own HTML', async () => {
    const { tool, human, setContent } = await setup()
    const ctx = human('alice')
    const { artifact } = (await tool('artifacts.create').handler(ctx, { kind: 'deck', name: 'Pitch', slides: [{ html: '<p>a</p>' }] })) as Out
    const out = (await tool('artifacts.export_pdf').handler(ctx, { file_id: artifact.id })) as { file: { name: string; mime: string } }
    expect(out.file).toMatchObject({ name: 'Pitch.pdf', mime: 'application/pdf' })
    expect(setContent).toHaveBeenCalledWith(expect.stringContaining('<p>a</p>'), expect.anything())
  })
})
