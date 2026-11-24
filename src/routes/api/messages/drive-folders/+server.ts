import type { DriveFolderOption } from '$lib/messages/composer'
import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { driveJson, driveService, type Actor, DriveError } from '$lib/server/drive'
import { errorReport, refusalReport } from '$lib/server/errors/report'

const ATTEMPTED = 'Listing Drive folders (/api/messages/drive-folders)'
const MAX_RESULTS = 50

export const GET: RequestHandler = async (event) => {
  if (!event.locals.user) {
    return json(refusalReport('sign in first', { attempted: ATTEMPTED }), { status: 401 })
  }
  const actor: Actor = { kind: 'user', userId: event.locals.user.id }
  const q = event.url.searchParams.get('q')?.trim() ?? ''

  try {
    return await driveJson(event, async () => {
      const drive = await driveService()
      if (!q) {
        const [myDrive, shared, messages, sources] = await Promise.all([
          drive.listFolder(actor, null),
          drive.sharedWithMe(actor),
          drive.messagesFolders(actor),
          drive.sourceRoots(actor),
        ])
        const byId = new Map<string, DriveFolderOption>()
        const add = (id: string, name: string, pathLabel: string) => {
          if (!byId.has(id) && byId.size < MAX_RESULTS) {
            byId.set(id, { id, name, pathLabel, href: `/drive/folder/${id}` })
          }
        }
        for (const item of myDrive.items) {
          if (item.type === 'folder') add(item.id, item.name, myDrive.root.label)
        }
        for (const item of shared) {
          if (item.type === 'folder') add(item.id, item.name, 'Shared with me')
        }
        for (const item of messages) {
          if (item.type === 'folder') add(item.id, item.name, 'Messages')
        }
        for (const root of sources) {
          add(root.folderId, root.name, root.name)
        }
        return { folders: [...byId.values()] }
      }

      const hits = (await drive.search(actor, q)).filter((i) => i.type === 'folder')
      const ordered = [
        ...hits.filter((i) => !i.inArchive && !i.archivedAt),
        ...hits.filter((i) => i.inArchive || i.archivedAt),
      ].slice(0, MAX_RESULTS)

      const resolved = await Promise.all(
        ordered.map(async (f): Promise<DriveFolderOption | null> => {
          try {
            const listing = await drive.listFolder(actor, f.id)
            const ancestors =
              listing.path.at(-1)?.id === f.id ? listing.path.slice(0, -1) : listing.path
            const pathLabel = [listing.root.label, ...ancestors.map((c) => c.name)].join(' / ')
            return {
              id: f.id,
              name: f.name,
              pathLabel,
              href: `/drive/folder/${f.id}`,
            }
          } catch (err) {
            if (err instanceof DriveError && (err.code === 'not_found' || err.code === 'forbidden')) {
              return null
            }
            throw err
          }
        }),
      )

      return { folders: resolved.filter((x): x is DriveFolderOption => x !== null) }
    })
  } catch (err) {
    console.error('[messages] drive-folders failed', err)
    return json(
      errorReport(err, {
        attempted: ATTEMPTED,
        plain: (e) => (e instanceof Error ? e.message : String(e)),
      }),
      { status: 500 },
    )
  }
}
