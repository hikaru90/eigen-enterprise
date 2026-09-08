import { randomUUID } from 'node:crypto'
import type {
  AllowlistEntry,
  AllowlistStore,
  GatewaySession,
  SessionStore,
} from '$lib/kernel/gateway'

function allowlistKey(platform: string, externalUserId: string): string {
  return `${platform}${externalUserId}`
}

export class InMemoryAllowlistStore implements AllowlistStore {
  private readonly entries = new Map<string, AllowlistEntry>()

  async isAllowed(platform: string, externalUserId: string): Promise<boolean> {
    return this.entries.has(allowlistKey(platform, externalUserId))
  }

  async principalFor(platform: string, externalUserId: string): Promise<string | null> {
    return this.entries.get(allowlistKey(platform, externalUserId))?.principalId ?? null
  }

  async add(platform: string, externalUserId: string, principalId: string): Promise<void> {
    this.entries.set(allowlistKey(platform, externalUserId), {
      platform,
      externalUserId,
      principalId,
    })
  }

  async remove(platform: string, externalUserId: string): Promise<void> {
    this.entries.delete(allowlistKey(platform, externalUserId))
  }

  async list(): Promise<AllowlistEntry[]> {
    return [...this.entries.values()]
  }
}

function sessionKey(platform: string, externalChatId: string): string {
  return `${platform}${externalChatId}`
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, GatewaySession>()

  async touch(platform: string, externalChatId: string, principalId: string): Promise<{ id: string }> {
    const key = sessionKey(platform, externalChatId)
    const existing = this.sessions.get(key)
    if (existing) {
      existing.principalId = principalId
      existing.lastSeenAt = new Date().toISOString()
      return { id: existing.id }
    }
    const session: GatewaySession = {
      id: randomUUID(),
      platform,
      externalChatId,
      principalId,
      lastSeenAt: new Date().toISOString(),
    }
    this.sessions.set(key, session)
    return { id: session.id }
  }

  async get(
    platform: string,
    externalChatId: string,
  ): Promise<{ id: string; principalId: string } | null> {
    const session = this.sessions.get(sessionKey(platform, externalChatId))
    if (!session) return null
    return { id: session.id, principalId: session.principalId }
  }
}
