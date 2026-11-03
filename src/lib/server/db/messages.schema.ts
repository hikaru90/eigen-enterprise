import { bigserial, boolean, pgTable, primaryKey, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

/**
 * Messages core (plan/phase-workspace.md C1, migration 0109). Company-level
 * tables (no RLS): access is decided in the messages service through the
 * access contract (channels) and membership rows (DMs).
 */

export const messageConversations = pgTable('message_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: ['channel', 'dm'] }).notNull(),
  name: text('name'),
  topic: text('topic').default('').notNull(),
  private: boolean('private').default(false).notNull(),
  archived: boolean('archived').default(false).notNull(),
  /** Sorted member ids joined by ","; DMs only — dedupes a member set. */
  dmKey: text('dm_key').unique(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const messageConversationMembers = pgTable(
  'message_conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => messageConversations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    /** Last heartbeat while the person had this conversation open (push suppression). */
    viewingAt: timestamp('viewing_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId], name: 'message_conversation_members_pk' })],
)

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => messageConversations.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  /** Markdown source; rendered + sanitized at display time. */
  body: text('body').notNull(),
  /** Reserved for threads (C2). */
  parentId: uuid('parent_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

export const messageEvents = pgTable('message_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  kind: text('kind', {
    enum: ['message.created', 'message.edited', 'message.deleted', 'conversation.created', 'conversation.read'],
  }).notNull(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => messageConversations.id, { onDelete: 'cascade' }),
  messageId: uuid('message_id'),
  /** conversation.read only: whose read state changed (delivered to that person alone). */
  userId: text('user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
