/** The Drive rail's sections. */
export type DriveSection = 'mine' | 'shared' | 'messages' | 'trash'

/** Where a folder or file path starts (the server's PathRoot.href) → the section it belongs to. */
const SECTION_OF_ROOT: Record<string, DriveSection> = {
  '/drive': 'mine',
  '/drive/shared': 'shared',
  '/messages': 'messages',
}

const SECTION_OF_PAGE: Record<string, DriveSection> = {
  '/drive': 'mine',
  '/drive/shared': 'shared',
  '/drive/messages': 'messages',
  '/drive/trash': 'trash',
}

/**
 * The current rail section: a section page by its path; a folder or file by
 * the root of its path (whose tree it is in, as the server decided).
 */
export function driveSection(pathname: string, rootHref: string | null): DriveSection | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  const own = SECTION_OF_PAGE[path]
  if (own) return own
  if (path.startsWith('/drive/folder/') || path.startsWith('/drive/file/')) {
    if (rootHref === null) return null
    const section = SECTION_OF_ROOT[rootHref]
    if (!section) throw new Error(`Drive path root ${rootHref} belongs to no section`)
    return section
  }
  return null
}
