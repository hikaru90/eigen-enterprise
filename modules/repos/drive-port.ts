/**
 * How the GitHub repos plugin writes its read-only copies into Drive
 * (plan/github-drive.md §5). The consumer owns the port, like Calls'
 * CallContextPort: Drive implements its system writer in S2, and the
 * composition root (modules/index.ts) adapts it to this type, because
 * modules never import each other.
 *
 * Everything written through this port is a "source item": read-only for
 * every person and agent (only sharing stays with owner/admins), visible to
 * the whole company through a view grant on the source root, excluded from
 * archive suggestions, the git-native data repo and backups.
 *
 * Items are addressed by the source's own stable keys, never by Drive ids or
 * names: Drive has no unique (parent, name), so it keeps the key → item map
 * (`drive_source_items`). Keys are opaque strings chosen by the source, e.g.
 * `repo:123456`, `repo:123456/Overview.md`, `repo:123456/docs/guide/intro.md`.
 */

/** The plugin id, stored as `drive_folder.source` / `drive_file.source`. */
export type DriveSourceId = string

export type DriveSourceRoot = {
  source: DriveSourceId
  /** Drive folder id of the root ("GitHub"). */
  folderId: string
  /** Name shown in the Drive rail and the path. */
  name: string
}

export type DriveSourceItem = {
  key: string
  kind: 'folder' | 'file'
  /** Drive folder or file id. */
  itemId: string
  /** The parent's key; null for items directly under the root. */
  parentKey: string | null
  /** sha256 of the file's bytes; null for folders. */
  contentSha: string | null
}

export type DriveSourcePort = {
  /**
   * Creates the source's root folder on first use (with the company-wide
   * view grant) or renames it; returns it either way. Idempotent.
   */
  ensureRoot(source: DriveSourceId, name: string): Promise<DriveSourceRoot>

  /**
   * Creates or renames/moves a folder addressed by `key`. `name` must not
   * contain `/` (Drive's rule); the parent must already exist (null = root).
   * Returns the Drive folder id.
   */
  upsertFolder(source: DriveSourceId, key: string, parentKey: string | null, name: string): Promise<string>

  /**
   * Creates or updates a text file (stored as `text/markdown`, no Drive
   * revisions). Writes a blob and touches `updatedAt` only when the content's
   * sha256 differs from the stored one. Returns the file id and whether it
   * changed.
   */
  upsertText(
    source: DriveSourceId,
    key: string,
    parentKey: string | null,
    name: string,
    content: string,
  ): Promise<{ fileId: string; changed: boolean }>

  /**
   * Deletes for good every item whose key equals `keyPrefix` or starts with
   * `keyPrefix + '/'` (derived data: nothing goes to the trash). Returns how
   * many items were removed.
   */
  remove(source: DriveSourceId, keyPrefix: string): Promise<number>

  /** Every item of the source (the root excluded), for reconciling a sync. */
  list(source: DriveSourceId): Promise<DriveSourceItem[]>
}
