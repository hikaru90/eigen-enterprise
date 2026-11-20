import { readTarGz, type TarEntry, type TarHeader } from '$lib/server/github/tar'
import { sweepTarballs as sweepGitHubTarballs } from '$lib/server/github/token'

/**
 * The seam to M1's GitHub tarball code (src/lib/server/github/): the repos
 * sync consumes a downloaded tarball, and sweeps leftover ones, only through
 * the shapes here, wired in live.ts with the real functions and in the test
 * setup with the fakes. This is the one file that touches M1's reader and
 * sweeper directly.
 *
 * The reader asks `want` with each regular file's header and yields only the
 * wanted entries, one at a time; an unwanted entry is skipped without being
 * read into memory — so a 20 MB+ file or an unchanged file is never held. The
 * tarball itself is a temp file on disk. Paths keep the archive's top folder
 * (`<owner>-<repo>-<sha>/…`); stripping it is the consumer's job.
 */
export type TarballHeader = TarHeader
export type TarballEntry = TarEntry
export type TarballReader = (filePath: string, opts: { want: (h: TarballHeader) => boolean }) => AsyncIterable<TarballEntry>

/** Removes tarball temp files under `dir` older than `olderThanMs` (a crashed sync leaves its download behind). */
export type TarballSweeper = (dir: string, olderThanMs: number, now: Date) => Promise<unknown>

export const liveTarballReader: TarballReader = (filePath, opts) => readTarGz(filePath, opts)
export const liveTarballSweeper: TarballSweeper = (dir, olderThanMs, now) => sweepGitHubTarballs(dir, olderThanMs, now)

/**
 * Strips the tarball's top folder (`<owner>-<repo>-<sha>/`). Returns null for
 * an entry with no folder below the top level (archive metadata).
 */
export function stripTopFolder(path: string): string | null {
  const i = path.indexOf('/')
  return i === -1 ? null : path.slice(i + 1)
}
