/**
 * The artifact beside the chat (plan/phase-artifacts.md): when the assistant
 * creates or changes an artifact (a tool step's `artifact`), the panel opens
 * it rendered — sandboxed, from a fresh view address — and loads it again on
 * every later change. Explicit calls only (show/close/exportPdf), no effects.
 */

export type ArtifactPanelKind = 'page' | 'deck'

export type ArtifactPanelView = {
  fileId: string
  name: string
  kind: ArtifactPanelKind
  slideCount: number | null
  viewUrl: string
}

export type ArtifactExport = { status: 'idle' } | { status: 'exporting' } | { status: 'done'; fileId: string; name: string } | { status: 'failed'; message: string }

type ViewBody = { artifact: { id: string; name: string; kind: ArtifactPanelKind; slideCount: number | null }; viewUrl: string }

async function messageOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown }; message?: unknown } | null
  const m = body?.error?.message ?? body?.message
  return typeof m === 'string' && m ? m : fallback
}

export class ArtifactPanel {
  /** The artifact open beside the chat, or null (closed). */
  fileId = $state<string | null>(null)
  view = $state<ArtifactPanelView | null>(null)
  status = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  error = $state<string | null>(null)
  exported = $state<ArtifactExport>({ status: 'idle' })

  #fetch: typeof globalThis.fetch
  #seq = 0

  constructor(fetchFn: typeof globalThis.fetch) {
    this.#fetch = fetchFn
  }

  get open(): boolean {
    return this.fileId !== null
  }

  /** Opens (or reloads, after a change) the artifact; the newest call wins. */
  async show(fileId: string): Promise<void> {
    const seq = ++this.#seq
    if (this.fileId !== fileId) {
      this.view = null
      this.exported = { status: 'idle' }
    }
    this.fileId = fileId
    this.status = 'loading'
    this.error = null
    try {
      const res = await this.#fetch(`/api/drive/artifacts/${encodeURIComponent(fileId)}`)
      if (!res.ok) throw new Error(await messageOf(res, 'The artifact could not be opened.'))
      const body = (await res.json()) as ViewBody
      if (seq !== this.#seq) return
      this.view = { fileId, name: body.artifact.name, kind: body.artifact.kind, slideCount: body.artifact.slideCount, viewUrl: body.viewUrl }
      this.status = 'ready'
    } catch (err) {
      if (seq !== this.#seq) return
      console.error('[assistant] artifact load failed', err)
      this.status = 'failed'
      this.error = err instanceof Error ? err.message : 'The artifact could not be opened.'
    }
  }

  close(): void {
    this.#seq += 1
    this.fileId = null
    this.view = null
    this.status = 'idle'
    this.error = null
    this.exported = { status: 'idle' }
  }

  /** Export PDF: saved in Drive next to the artifact (= artifacts.export_pdf). */
  async exportPdf(): Promise<void> {
    const fileId = this.fileId
    if (!fileId) return
    this.exported = { status: 'exporting' }
    try {
      const res = await this.#fetch(`/api/drive/artifacts/${encodeURIComponent(fileId)}/pdf`, { method: 'POST' })
      if (!res.ok) throw new Error(await messageOf(res, 'The PDF could not be made.'))
      const body = (await res.json()) as { file: { id: string; name: string } }
      if (this.fileId === fileId) this.exported = { status: 'done', fileId: body.file.id, name: body.file.name }
    } catch (err) {
      if (this.fileId === fileId) this.exported = { status: 'failed', message: err instanceof Error ? err.message : 'The PDF could not be made.' }
    }
  }
}
