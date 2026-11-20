import type { TarEntry } from '$lib/server/github/tar'

/**
 * The seam to the streaming tar reader (src/lib/server/github/tar.ts, shipped
 * by M1): the repos sync consumes a downloaded tarball only through this one
 * shape, wired in live.ts and the test setup with `readTarGz` itself. Entries
 * arrive one file at a time — callers never hold the archive in memory; the
 * tarball itself is a temp file on disk. Paths keep the archive's top folder
 * (`<owner>-<repo>-<sha>/…`); stripping it is the consumer's job.
 */
export type TarballEntry = TarEntry
export type TarballReader = (filePath: string) => AsyncIterable<TarballEntry>

/**
 * Strips the tarball's top folder (`<owner>-<repo>-<sha>/`). Returns null for
 * an entry with no folder below the top level (archive metadata).
 */
export function stripTopFolder(path: string): string | null {
  const i = path.indexOf('/')
  return i === -1 ? null : path.slice(i + 1)
}
