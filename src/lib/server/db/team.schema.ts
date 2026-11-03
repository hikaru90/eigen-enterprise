import { sql } from 'drizzle-orm'
import { check, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './auth.schema'

/**
 * Team (plan/phase-workspace.md T1, migration 0107): groups of members
 * (Sales, Dev …) and the access grants Drive and Messages check through
 * src/lib/server/access. Users are Better Auth rows; deleting a user drops
 * their group memberships and personal grants (cascade).
 */
export const memberGroup = pgTable(
  'member_group',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('member_group_name_lower').on(sql`lower(${t.name})`)],
)

export const memberGroupMember = pgTable(
  'member_group_member',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => memberGroup.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('member_group_member_user_idx').on(t.userId)],
)

export const accessGrant = pgTable(
  'access_grant',
  {
    id: text('id').primaryKey(),
    resourceType: text('resource_type', { enum: ['channel', 'folder', 'file'] }).notNull(),
    resourceId: text('resource_id').notNull(),
    subjectKind: text('subject_kind', { enum: ['user', 'group', 'company'] }).notNull(),
    subjectUserId: text('subject_user_id').references(() => user.id, { onDelete: 'cascade' }),
    subjectGroupId: text('subject_group_id').references(() => memberGroup.id, { onDelete: 'cascade' }),
    level: text('level', { enum: ['view', 'edit', 'manage'] }).notNull(),
    grantedBy: text('granted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('access_grant_resource_idx').on(t.resourceType, t.resourceId),
    uniqueIndex('access_grant_subject_unique').on(
      t.resourceType,
      t.resourceId,
      t.subjectKind,
      sql`coalesce(${t.subjectUserId}, ${t.subjectGroupId}, '')`,
    ),
    check(
      'access_grant_subject_shape',
      sql`(${t.subjectKind} = 'user' AND ${t.subjectUserId} IS NOT NULL AND ${t.subjectGroupId} IS NULL)
        OR (${t.subjectKind} = 'group' AND ${t.subjectGroupId} IS NOT NULL AND ${t.subjectUserId} IS NULL)
        OR (${t.subjectKind} = 'company' AND ${t.subjectUserId} IS NULL AND ${t.subjectGroupId} IS NULL)`,
    ),
  ],
)
