import { createHash } from 'node:crypto'
import {
  DATA_FILE_MAX_BYTES,
  DATA_MODULE_MAX_BYTES,
  type Json,
} from '../../../../contracts/module-protocol'
import { KernelError } from '../errors'
import type { ModuleDataRepo } from './types'

/**
 * `data.*` (plan/phase-upgrades-u2.md §4.3, D7): a module's only persistence,
 * files under `extensions/<id>/` in the company data repo. Each file holds
 * one JSON value (a string is a JSON string), stored as its JSON text plus a
 * newline, so a file reads back exactly as written and diffs line by line in
 * git. The etag is the sha256 of the stored bytes. Paths arrive validated by
 * the protocol (`dataPathSchema`: relative, no empty, "." or ".." segments);
 * the data repo checks them again as repo paths.
 */

/** How many items one `data.list` page holds. */
export const DATA_LIST_PAGE = 100

export const extensionsPrefix = (moduleId: string): string => `extensions/${moduleId}/`

export const dataEtag = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

function encode(content: Json): Uint8Array {
  return Buffer.from(`${JSON.stringify(content)}\n`, 'utf8')
}

function decode(bytes: Uint8Array, path: string): Json {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as Json
  } catch {
    throw new KernelError('data_conflict', `data file ${path} is not JSON; it was changed outside the module`, {
      path,
    })
  }
}

export class ModuleData {
  constructor(
    private readonly repo: ModuleDataRepo,
    private readonly moduleId: string,
    /** Who data writes are authored by (the module's principal id, `module:<id>`). */
    private readonly authorId: string,
  ) {}

  private full(path: string): string {
    return `${extensionsPrefix(this.moduleId)}${path}`
  }

  async get(path: string): Promise<{ content: Json; etag: string }> {
    const bytes = await this.repo.read(this.full(path))
    if (bytes === null) throw new KernelError('data_not_found', `no data file ${path}`, { path })
    return { content: decode(bytes, path), etag: dataEtag(bytes) }
  }

  async put(path: string, content: Json, ifMatch?: string): Promise<{ etag: string }> {
    const bytes = encode(content)
    if (bytes.byteLength > DATA_FILE_MAX_BYTES) {
      throw new KernelError(
        'data_quota',
        `data file ${path} would be ${bytes.byteLength} bytes; one file holds at most ${DATA_FILE_MAX_BYTES}`,
        { path, bytes: bytes.byteLength, max: DATA_FILE_MAX_BYTES },
      )
    }
    const full = this.full(path)
    const current = await this.repo.read(full)
    if (ifMatch !== undefined && (current === null || dataEtag(current) !== ifMatch)) {
      throw new KernelError('data_conflict', `data file ${path} changed since etag ${ifMatch}`, {
        path,
        etag: current === null ? null : dataEtag(current),
      })
    }
    const files = await this.repo.list(extensionsPrefix(this.moduleId))
    const total = files.reduce((sum, f) => sum + (f.path === full ? 0 : f.size), 0) + bytes.byteLength
    if (total > DATA_MODULE_MAX_BYTES) {
      throw new KernelError(
        'data_quota',
        `module ${this.moduleId} would hold ${total} bytes of data; at most ${DATA_MODULE_MAX_BYTES}`,
        { path, total, max: DATA_MODULE_MAX_BYTES },
      )
    }
    if (current === null || dataEtag(current) !== dataEtag(bytes)) {
      await this.repo.write([{ path: full, bytes }], {
        authorId: this.authorId,
        message: `${this.moduleId}: write ${path}`,
      })
    }
    return { etag: dataEtag(bytes) }
  }

  async list(
    prefix: string | undefined,
    cursor: string | undefined,
  ): Promise<{ items: { path: string; etag: string; size: number }[]; cursor: string | null }> {
    if (prefix !== undefined && (prefix.startsWith('/') || prefix.split('/').some((s) => s === '..' || s === '.'))) {
      throw new KernelError('invalid_input', `data.list prefix "${prefix}" is not a relative path prefix`)
    }
    const base = extensionsPrefix(this.moduleId)
    const all = (await this.repo.list(base))
      .map((f) => ({ ...f, rel: f.path.slice(base.length) }))
      .filter((f) => prefix === undefined || f.rel.startsWith(prefix))
      .filter((f) => cursor === undefined || f.rel > cursor)
    const page = all.slice(0, DATA_LIST_PAGE)
    const items = []
    for (const f of page) {
      const bytes = await this.repo.read(f.path)
      if (bytes === null) continue // deleted meanwhile
      items.push({ path: f.rel, etag: dataEtag(bytes), size: bytes.byteLength })
    }
    return { items, cursor: all.length > page.length ? page[page.length - 1]!.rel : null }
  }

  async delete(path: string, ifMatch?: string): Promise<Record<string, never>> {
    const full = this.full(path)
    const current = await this.repo.read(full)
    if (current === null) {
      if (ifMatch !== undefined) {
        throw new KernelError('data_conflict', `data file ${path} is gone, not at etag ${ifMatch}`, { path })
      }
      return {}
    }
    if (ifMatch !== undefined && dataEtag(current) !== ifMatch) {
      throw new KernelError('data_conflict', `data file ${path} changed since etag ${ifMatch}`, {
        path,
        etag: dataEtag(current),
      })
    }
    await this.repo.write([{ path: full, bytes: null }], {
      authorId: this.authorId,
      message: `${this.moduleId}: delete ${path}`,
    })
    return {}
  }
}
