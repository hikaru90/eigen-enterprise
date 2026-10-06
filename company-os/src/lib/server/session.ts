/**
 * Conversation sessions — persisted after every message (first-conversation §5:
 * "Founder leaves mid-conversation → nothing is lost, ever").
 */

import type { Sql } from './db.ts';
import type { ChatMessage } from './llm.ts';

export type SessionStatus = 'open' | 'completed';

export type SessionRecord = {
	id: string;
	status: SessionStatus;
	createdAt: string;
	updatedAt: string;
	messages: ChatMessage[];
}

export type SessionStore = {
	create(): Promise<SessionRecord>;
	/** Append messages in order; sequence numbers are assigned by the store. */
	append(sessionId: string, messages: ChatMessage[]): Promise<void>;
	get(sessionId: string): Promise<SessionRecord | null>;
	/** Most recent non-empty open session — the resume candidate. */
	latestOpen(): Promise<SessionRecord | null>;
	markCompleted(sessionId: string): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
	private readonly sessions = new Map<string, SessionRecord>();
	private readonly touched = new Map<string, number>();
	private counter = 0;

	private touch(id: string): void {
		this.counter += 1;
		this.touched.set(id, this.counter);
	}

	async create(): Promise<SessionRecord> {
		const now = new Date().toISOString();
		const record: SessionRecord = {
			id: crypto.randomUUID(),
			status: 'open',
			createdAt: now,
			updatedAt: now,
			messages: []
		};
		this.sessions.set(record.id, record);
		this.touch(record.id);
		return this.snapshot(record);
	}

	async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
		const record = this.sessions.get(sessionId);
		if (!record) throw new Error(`Session ${sessionId} does not exist.`);
		record.messages.push(...messages.map((m) => ({ ...m })));
		record.updatedAt = new Date().toISOString();
		this.touch(sessionId);
	}

	async get(sessionId: string): Promise<SessionRecord | null> {
		const record = this.sessions.get(sessionId);
		return record ? this.snapshot(record) : null;
	}

	async latestOpen(): Promise<SessionRecord | null> {
		// Monotonic touch order beats ISO timestamps: two updates can share a millisecond.
		const open = [...this.sessions.values()]
			.filter((r) => r.status === 'open')
			.sort((a, b) => (this.touched.get(b.id) ?? 0) - (this.touched.get(a.id) ?? 0));
		return open[0] ? this.snapshot(open[0]) : null;
	}

	async markCompleted(sessionId: string): Promise<void> {
		const record = this.sessions.get(sessionId);
		if (!record) throw new Error(`Session ${sessionId} does not exist.`);
		record.status = 'completed';
		record.updatedAt = new Date().toISOString();
		this.touch(sessionId);
	}

	private snapshot(record: SessionRecord): SessionRecord {
		return { ...record, messages: record.messages.map((m) => ({ ...m })) };
	}
}

type MessageRow = {
	role: string;
	content: string | null;
	/** jsonb — the driver may deliver this parsed or as a raw JSON string. */
	tool_calls: unknown;
	tool_call_id: string | null;
}

type SessionRow = {
	id: string;
	status: string;
	created_at: Date;
	updated_at: Date;
}

export class PgSessionStore implements SessionStore {
	private readonly sql: Sql;

	constructor(sql: Sql) {
		this.sql = sql;
	}

	async create(): Promise<SessionRecord> {
		const rows = await this.sql`
			insert into agent_sessions default values
			returning id, status, created_at, updated_at
		`;
		const row = rows[0]!;
		return {
			id: row.id,
			status: row.status as SessionStatus,
			createdAt: row.created_at.toISOString(),
			updatedAt: row.updated_at.toISOString(),
			messages: []
		};
	}

	async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
		await this.sql.begin(async (tx) => {
			const locked = await tx`
				select id from agent_sessions where id = ${sessionId} for update
			`;
			if (locked.length === 0) throw new Error(`Session ${sessionId} does not exist.`);
			const seqRows = await tx`
				select coalesce(max(seq), -1) + 1 as next from agent_messages where session_id = ${sessionId}
			`;
			let seq = seqRows[0]!.next as number;
			for (const message of messages) {
				await tx`
					insert into agent_messages (session_id, seq, role, content, tool_calls, tool_call_id)
					values (${sessionId}, ${seq}, ${message.role}, ${message.content},
					        ${message.tool_calls ? JSON.stringify(message.tool_calls) : null}, ${message.tool_call_id ?? null})
				`;
				seq += 1;
			}
			await tx`update agent_sessions set updated_at = now() where id = ${sessionId}`;
		});
	}

	async get(sessionId: string): Promise<SessionRecord | null> {
		const sessions = await this.sql<SessionRow[]>`
			select id, status, created_at, updated_at from agent_sessions where id = ${sessionId}
		`;
		const session = sessions[0];
		if (!session) return null;
		const messages = await this.sql<MessageRow[]>`
			select role, content, tool_calls, tool_call_id
			from agent_messages where session_id = ${sessionId}
			order by seq asc
		`;
		return {
			id: session.id,
			status: session.status as SessionStatus,
			createdAt: session.created_at.toISOString(),
			updatedAt: session.updated_at.toISOString(),
			messages: messages.map(rowToMessage)
		};
	}

	async latestOpen(): Promise<SessionRecord | null> {
		const rows = await this.sql`
			select id from agent_sessions where status = 'open'
			order by updated_at desc, id desc
			limit 1
		`;
		const row = rows[0];
		return row ? this.get(row.id) : null;
	}

	async markCompleted(sessionId: string): Promise<void> {
		const rows = await this.sql`
			update agent_sessions set status = 'completed', updated_at = now()
			where id = ${sessionId}
			returning id
		`;
		if (rows.length === 0) throw new Error(`Session ${sessionId} does not exist.`);
	}
}

function rowToMessage(row: MessageRow): ChatMessage {
	const message: ChatMessage = { role: row.role as ChatMessage['role'], content: row.content };
	const toolCalls = parseToolCalls(row.tool_calls);
	if (toolCalls) message.tool_calls = toolCalls;
	if (row.tool_call_id) message.tool_call_id = row.tool_call_id;
	return message;
}

/** The driver may deliver jsonb parsed or as a raw string — accept both. */
function parseToolCalls(raw: unknown): ChatMessage['tool_calls'] | null {
	if (raw == null) return null;
	if (typeof raw === 'string') return JSON.parse(raw) as ChatMessage['tool_calls'];
	return raw as ChatMessage['tool_calls'];
}
