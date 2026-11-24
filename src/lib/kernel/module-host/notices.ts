import type { ModuleRecord, SharingAcceptance } from './types'

/**
 * Needs you (plan/phase-upgrades-u2.md §4.6, §6.6, D13): what the company's
 * own modules ask of a person. Derived from the records, never stored twice:
 * an entry lasts exactly as long as its cause.
 *
 * - a failed module: its owner and the admins, with the module's own sentence;
 * - a deploy that needs an admin's own click: the admins;
 * - the one-time sharing OK: the owner, once a module exists and until they OK it.
 */
export type ModuleNotice =
  | { kind: 'module_failed'; moduleId: string; name: string; sentence: string; since: string }
  | { kind: 'module_deploy_needs_admin'; moduleId: string; name: string; commit: string; by: string; at: string }
  | { kind: 'module_sharing'; sentence: string }

export const SHARING_SENTENCE =
  'Modules you build here are open source (Apache-2.0) and shared with eigenEnterprise.'

export type NoticeViewer = { userId: string; isOwner: boolean; isAdmin: boolean }

export function moduleNotices(
  records: readonly ModuleRecord[],
  sharing: SharingAcceptance | null,
  viewer: NoticeViewer,
): ModuleNotice[] {
  const out: ModuleNotice[] = []
  const name = (r: ModuleRecord) => r.manifest?.name ?? r.id
  for (const r of records) {
    if (r.state === 'failed' && r.reason && (viewer.isAdmin || viewer.isOwner || r.ownerUserId === viewer.userId)) {
      out.push({ kind: 'module_failed', moduleId: r.id, name: name(r), sentence: r.reason, since: r.stateSince })
    }
    if (r.pendingDeploy && (viewer.isAdmin || viewer.isOwner)) {
      out.push({
        kind: 'module_deploy_needs_admin',
        moduleId: r.id,
        name: name(r),
        commit: r.pendingDeploy.commit,
        by: r.pendingDeploy.by,
        at: r.pendingDeploy.at,
      })
    }
  }
  if (viewer.isOwner && sharing === null && records.length > 0) {
    out.push({ kind: 'module_sharing', sentence: SHARING_SENTENCE })
  }
  return out
}
