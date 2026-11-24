export type ReturnTo = {
  href: string
  label: string
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isMessagesPath(path: string): boolean {
  if (!path.startsWith('/messages')) return false
  if (path.length === 9) return true
  const next = path[9]
  return next === '?' || next === '/' || next === '#'
}

/**
 * Validates an internal `from` return path back to Messages.
 * Accepts only relative paths under `/messages` and rejects schemes,
 * protocol-relative prefixes, `..` traversal, backslashes, and control characters.
 */
export function safeReturnTo(raw: string | null | undefined): ReturnTo | null {
  if (!raw || hasControlChar(raw) || raw.includes('\\') || raw.includes('..')) return null
  if (!isMessagesPath(raw)) return null

  let url: URL
  try {
    url = new URL(raw, 'https://ee.invalid')
  } catch {
    return null
  }
  if (url.origin !== 'https://ee.invalid' || url.username || url.password) return null
  if (url.pathname !== '/messages' && !url.pathname.startsWith('/messages/')) return null

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (hasControlChar(decodedPath) || decodedPath.includes('\\') || decodedPath.includes('..')) {
    return null
  }

  return {
    href: `${url.pathname}${url.search}${url.hash}`,
    label: 'Messages',
  }
}
