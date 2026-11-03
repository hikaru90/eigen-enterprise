/**
 * Request body limit for the os workload (adapter-node `BODY_SIZE_LIMIT`).
 * adapter-node defaults to 512K, which would refuse every Drive upload above
 * half a megabyte; the Drive's own limit (DRIVE_MAX_UPLOAD_BYTES, default
 * 100 MB) is the real per-file gate, so this sits above it with room for the
 * multipart envelope.
 */
export const OS_BODY_SIZE_LIMIT = '110M'

/** Bytes for an adapter-node size string (`<n>`, `<n>K`, `<n>M`, `<n>G`); anything else is refused. */
export function bodyLimitBytes(value: string): number {
  const m = /^(\d+)([KMG]?)$/.exec(value.trim())
  if (!m) throw new Error(`BODY_SIZE_LIMIT must be a number of bytes with an optional K, M or G suffix, got "${value}"`)
  const unit = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2] as '' | 'K' | 'M' | 'G']
  return Number(m[1]) * unit
}
