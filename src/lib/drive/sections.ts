/** The Drive rail's sections: the fixed ones, and one per source root (read-only source folders). */
export type DriveSection = 'mine' | 'shared' | 'messages' | 'archived' | 'trash' | `source:${string}`

/** A source root as the rail lists it (the server's SourceRootView): its id and where its tree starts. */
export type SourceSection = { source: string; href: string }

/** The rail section of a source root. */
export const sourceSection = (source: string): DriveSection => `source:${source}`

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
  '/drive/archived': 'archived',
  '/drive/trash': 'trash',
}

/**
 * The current rail section: a section page by its path; a folder or file by
 * the root of its path (whose tree it is in, as the server decided) — a
 * source root's tree is that source's section.
 */
export function driveSection(pathname: string, rootHref: string | null, sources: readonly SourceSection[]): DriveSection | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  const own = SECTION_OF_PAGE[path]
  if (own) return own
  if (path.startsWith('/drive/folder/') || path.startsWith('/drive/file/')) {
    if (rootHref === null) return null
    const section = SECTION_OF_ROOT[rootHref]
    if (section) return section
    const source = sources.find((s) => s.href === rootHref)
    if (source) return sourceSection(source.source)
    throw new Error(`Drive path root ${rootHref} belongs to no section`)
  }
  return null
}
