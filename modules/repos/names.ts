/**
 * Drive's name rule for source items, mirrored exactly from `checkName` in
 * modules/drive/source-writer.ts (modules never import each other): non-empty,
 * no leading or trailing whitespace, at most 255 characters, no `/` or `\`,
 * not `.` or `..`. The sync checks every path segment with it up front, so a
 * name Drive would refuse becomes a "not copied: name" line, never a failed
 * batch. Keep the two in step.
 */
export function isDriveName(name: string): boolean {
  if (!name || name !== name.trim()) return false
  if (name.length > 255) return false
  return !/[/\\]/.test(name) && name !== '.' && name !== '..'
}

/** Used when the default branch's name can't be a Drive folder name even with `-` for `/`. */
export const TREE_FOLDER_FALLBACK = 'default branch'

/**
 * The display name of the copied tree's folder: the default branch, each `/`
 * replaced by `-` (`release/2.x` → `release-2.x`). Only the name: the key is
 * always `repo:<id>/tree`, so a renamed branch renames the folder in place.
 */
export function treeFolderName(branch: string): string {
  const name = branch.replaceAll('/', '-')
  return isDriveName(name) ? name : TREE_FOLDER_FALLBACK
}
