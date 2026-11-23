import { createHash } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'

/**
 * A zip written straight to disk, entry by entry, so an export with gigabytes
 * of Drive files never sits in memory. Every entry's sha256 and size are
 * recorded for the manifest. Already-compressed bytes (Drive blobs) are stored;
 * text is deflated.
 */

export type ArchiveEntry = { path: string; bytes: number; sha256: string }

export class StreamingArchive {
  private readonly zip: Zip
  private readonly out: WriteStream
  private readonly done: Promise<void>
  private readonly entries: ArchiveEntry[] = []
  private readonly paths = new Set<string>()
  private failed: Error | null = null

  constructor(private readonly file: string) {
    this.out = createWriteStream(file, { flags: 'wx' })
    let resolve!: () => void
    let reject!: (e: Error) => void
    this.done = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    this.out.on('error', (e) => {
      this.failed = e
      reject(e)
    })
    this.out.on('finish', () => resolve())
    // Seen by finish() or abort(); never an unhandled rejection in between.
    this.done.catch(() => {})
    this.zip = new Zip((err, chunk, final) => {
      if (err) {
        this.failed = err
        reject(err)
        return
      }
      this.out.write(chunk)
      if (final) this.out.end()
    })
  }

  private claim(path: string): void {
    if (this.failed) throw this.failed
    if (!path || path.startsWith('/') || path.split('/').some((p) => p === '..' || p === '')) {
      throw new Error(`archive: not a safe entry path: ${JSON.stringify(path)}`)
    }
    if (this.paths.has(path)) throw new Error(`archive: two entries at ${path}`)
    this.paths.add(path)
  }

  /** Adds one entry from chunks; `store` keeps bytes as they are (for already-compressed files). */
  async add(path: string, chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, opts: { store?: boolean } = {}): Promise<ArchiveEntry> {
    this.claim(path)
    const file = opts.store ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 })
    this.zip.add(file)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of chunks) {
      hash.update(chunk)
      bytes += chunk.byteLength
      file.push(chunk)
      await this.drain()
    }
    file.push(new Uint8Array(0), true)
    const entry = { path, bytes, sha256: hash.digest('hex') }
    this.entries.push(entry)
    return entry
  }

  addText(path: string, text: string): Promise<ArchiveEntry> {
    return this.add(path, [new TextEncoder().encode(text)])
  }

  /** Waits while the file stream is backed up, so a big table never piles up in memory. */
  private drain(): Promise<void> {
    if (this.failed) return Promise.reject(this.failed)
    if (!this.out.writableNeedDrain) return Promise.resolve()
    return new Promise((res) => this.out.once('drain', () => res()))
  }

  list(): readonly ArchiveEntry[] {
    return this.entries
  }

  async finish(): Promise<void> {
    if (this.failed) throw this.failed
    this.zip.end()
    await this.done
  }

  /** Stops writing after a failure and deletes the partial file (never leaves half an export). */
  async abort(): Promise<void> {
    this.zip.terminate()
    // Wait for the stream to close: its file may still be opening, and would appear after the rm.
    const closed = this.out.closed ? Promise.resolve() : new Promise<void>((res) => this.out.once('close', () => res()))
    this.out.destroy()
    await closed
    await rm(this.file, { force: true })
  }
}
