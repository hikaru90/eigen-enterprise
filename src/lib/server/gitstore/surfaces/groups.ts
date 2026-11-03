import type { GitAuthor, GitEngine } from '../engine'
import type { FormatMigration, IndexFramework, RepoFile, SurfaceAdapter } from '../framework'
import type { FileChange } from '../keys'
import { z } from 'zod'
import type { Group, GroupStore } from '$lib/server/members/groups'
import { canonicalYaml, parseYaml } from '../canonical'
import { LAYOUT, slugify } from '../layout'

/**
 * Groups on the git-native framework (G0 proof surface).
 *
 * File: `groups/<slug>.yaml` — canonical YAML, one group per file:
 *   createdAt, createdBy, description, format (eigen.group), id, members
 *   (ordered list of user ids, order = the order they were added), name,
 *   version (1).
 * The slug comes from the name; when another group's file already holds that
 * slug the file is `<slug>-<first 8 of id>.yaml`. A rename moves the file.
 * Index: member_group + member_group_member (Postgres), rebuilt from files.
 */

export const GROUPS_SURFACE = 'groups'
export const GROUP_FORMAT = 'eigen.group'
export const GROUP_VERSION = 1

export type GroupEntity = {
  id: string
  name: string
  description: string
  createdBy: string
  createdAt: Date
  memberIds: string[]
}

const fileSchema = z
  .object({
    format: z.literal(GROUP_FORMAT),
    version: z.literal(GROUP_VERSION),
    id: z.string().min(1),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(''),
    createdBy: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    members: z.array(z.string().min(1)).default([]),
  })
  .strict()

export function groupFileContent(g: GroupEntity): string {
  return canonicalYaml({
    format: GROUP_FORMAT,
    version: GROUP_VERSION,
    id: g.id,
    name: g.name,
    description: g.description,
    createdBy: g.createdBy,
    createdAt: g.createdAt,
    members: [...new Set(g.memberIds)],
  })
}

export function parseGroupFile(text: string): GroupEntity {
  const parsed = fileSchema.safeParse(parseYaml(text))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`${issue?.path.join('.') || 'file'}: ${issue?.message ?? 'invalid'}`)
  }
  const f = parsed.data
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    createdBy: f.createdBy,
    createdAt: new Date(f.createdAt),
    memberIds: [...new Set(f.members)],
  }
}

/** The index side of groups — Postgres in production, memory in tests. */
export type GroupIndex = {
  all(): Promise<GroupEntity[]>
  get(id: string): Promise<GroupEntity | null>
  upsert(group: GroupEntity): Promise<{ problems: string[] }>
  remove(id: string): Promise<void>
  /** Index == exactly these groups. */
  replaceAll(groups: GroupEntity[]): Promise<{ problems: string[] }>
}

/** `format` + `version` header of any YAML file family. */
export function yamlFormatOf(_path: string, text: string): { format: string; version: number } {
  const v = parseYaml(text) as { format?: unknown; version?: unknown } | null
  if (!v || typeof v.format !== 'string' || typeof v.version !== 'number')
    throw new Error('missing format/version')
  return { format: v.format, version: v.version }
}

export function groupsAdapter(
  index: GroupIndex,
  opts: { version?: number; migrations?: FormatMigration[] } = {},
): SurfaceAdapter<GroupEntity> {
  return {
    surface: GROUPS_SURFACE,
    format: GROUP_FORMAT,
    version: opts.version ?? GROUP_VERSION,
    formatOf: yamlFormatOf,
    migrations: opts.migrations ?? [],
    paths: [LAYOUT.groups],
    toFiles: (g) => [
      { path: `${LAYOUT.groups}${slugify(g.name)}.yaml`, content: groupFileContent(g) },
    ],
    fromFiles(files) {
      const rows: GroupEntity[] = []
      const problems: string[] = []
      const ids = new Set<string>()
      const names = new Set<string>()
      for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (!path.endsWith('.yaml') || path.slice(LAYOUT.groups.length).includes('/')) {
          problems.push(`${path}: not a group file (expected groups/<slug>.yaml) — ignored`)
          continue
        }
        let g: GroupEntity
        try {
          g = parseGroupFile(text)
        } catch (err) {
          problems.push(`${path}: ${(err as Error).message} — ignored`)
          continue
        }
        if (ids.has(g.id)) {
          problems.push(`${path}: duplicate group id ${g.id} — ignored`)
          continue
        }
        if (names.has(g.name.toLowerCase())) {
          problems.push(`${path}: another group is already called ${g.name} — ignored`)
          continue
        }
        ids.add(g.id)
        names.add(g.name.toLowerCase())
        rows.push(g)
      }
      return { rows, problems }
    },
    replaceIndex: (rows) => index.replaceAll(rows),
  }
}

export type AuthorResolver = (actorId: string) => Promise<GitAuthor>

async function groupFiles(engine: GitEngine): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const path of await engine.listWorking(LAYOUT.groups)) {
    const bytes = await engine.readWorking(path)
    if (bytes) out.set(path, Buffer.from(bytes).toString('utf8'))
  }
  return out
}

/** Where a group lives now (by id) and where it should live given its name. */
async function placement(
  engine: GitEngine,
  g: GroupEntity,
): Promise<{ current: string | null; target: string }> {
  let current: string | null = null
  const taken = new Set<string>()
  for (const [path, text] of await groupFiles(engine)) {
    let id: string | null
    try {
      id = parseGroupFile(text).id
    } catch {
      id = null // an unreadable file still occupies its path
    }
    if (id === g.id) current = path
    else taken.add(path)
  }
  const base = `${LAYOUT.groups}${slugify(g.name)}`
  const target = !taken.has(`${base}.yaml`) ? `${base}.yaml` : `${base}-${g.id.slice(0, 8)}.yaml`
  return { current, target }
}

function changesFor(
  p: { current: string | null; target: string },
  file: RepoFile | null,
): FileChange[] {
  const out: FileChange[] = []
  if (p.current && (file === null || p.current !== p.target))
    out.push({ path: p.current, content: null })
  if (file) out.push({ path: p.target, content: file.content })
  return out
}

export type GitGroupStoreDeps = {
  framework: IndexFramework
  index: GroupIndex
  /** Reads come from the index (Postgres in production). */
  reads: Pick<GroupStore, 'listGroups' | 'getGroup' | 'findGroupByName' | 'existingMemberIds'>
  author: AuthorResolver
  now?: () => Date
}

/** GroupStore whose writes go file-first through the git engine. */
export function gitGroupStore(deps: GitGroupStoreDeps): GroupStore {
  const { framework, index } = deps
  const engine = framework.engine
  const now = deps.now ?? (() => new Date())

  async function write(
    next: GroupEntity | null,
    id: string,
    actorId: string,
    message: string,
  ): Promise<void> {
    const prev = await index.get(id)
    const probe = next ?? prev
    if (!probe) throw new Error(`group ${id} is not in the index`)
    const p = await placement(engine, probe)
    const changes = changesFor(p, next ? { path: p.target, content: groupFileContent(next) } : null)
    if (changes.length === 0) return
    await framework.writeThrough({
      surface: GROUPS_SURFACE,
      changes,
      author: await deps.author(actorId),
      message,
      index: async () => {
        if (next) {
          const r = await index.upsert(next)
          if (r.problems.length) throw new Error(r.problems.join('; '))
        } else await index.remove(id)
      },
    })
  }

  async function current(id: string): Promise<GroupEntity> {
    const g = await index.get(id)
    if (!g) throw new Error(`group ${id} is not in the index`)
    return g
  }

  return {
    listGroups: () => deps.reads.listGroups(),
    getGroup: (id) => deps.reads.getGroup(id),
    findGroupByName: (name) => deps.reads.findGroupByName(name),
    existingMemberIds: (ids) => deps.reads.existingMemberIds(ids),
    async insertGroup(g) {
      const entity: GroupEntity = { ...g, memberIds: [...g.memberIds], createdAt: now() }
      await write(entity, g.id, g.createdBy, `groups: create ${g.name}`)
    },
    async updateGroup(id, patch, actorId) {
      const g = await current(id)
      await write({ ...g, ...patch }, id, actorId ?? g.createdBy, `groups: update ${patch.name}`)
    },
    async setGroupMembers(id, memberIds, actorId) {
      const g = await current(id)
      await write(
        { ...g, memberIds: [...memberIds] },
        id,
        actorId ?? g.createdBy,
        `groups: set members of ${g.name}`,
      )
    },
    async deleteGroup(id, actorId) {
      const g = await current(id)
      await write(null, id, actorId ?? g.createdBy, `groups: delete ${g.name}`)
    },
  }
}

/** In-memory GroupIndex + GroupStore reads over it (tests). */
export function memoryGroupIndex(memberIds: readonly string[] = []): GroupIndex & {
  rows: Map<string, GroupEntity>
  reads: Pick<GroupStore, 'listGroups' | 'getGroup' | 'findGroupByName' | 'existingMemberIds'>
} {
  const rows = new Map<string, GroupEntity>()
  const members = new Set(memberIds)
  const filterKnown = (g: GroupEntity) => {
    const unknown = g.memberIds.filter((m) => !members.has(m))
    return {
      g: { ...g, memberIds: g.memberIds.filter((m) => members.has(m)) },
      problems: unknown.map((u) => `group ${g.name}: unknown member ${u} skipped`),
    }
  }
  const toGroup = (g: GroupEntity): Group => ({
    id: g.id,
    name: g.name,
    description: g.description,
    createdAt: g.createdAt,
    memberIds: [...g.memberIds],
  })
  return {
    rows,
    async all() {
      return [...rows.values()]
    },
    async get(id) {
      return rows.get(id) ?? null
    },
    async upsert(g) {
      const f = filterKnown(g)
      rows.set(g.id, f.g)
      return { problems: f.problems }
    },
    async remove(id) {
      rows.delete(id)
    },
    async replaceAll(list) {
      rows.clear()
      const problems: string[] = []
      for (const g of list) {
        const f = filterKnown(g)
        rows.set(g.id, f.g)
        problems.push(...f.problems)
      }
      return { problems }
    },
    reads: {
      async listGroups() {
        return [...rows.values()]
          .map(toGroup)
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      },
      async getGroup(id) {
        const g = rows.get(id)
        return g ? toGroup(g) : null
      },
      async findGroupByName(name) {
        const g = [...rows.values()].find((r) => r.name.toLowerCase() === name.toLowerCase())
        return g ? toGroup(g) : null
      },
      async existingMemberIds(ids) {
        return new Set(ids.filter((i) => members.has(i)))
      },
    },
  }
}
