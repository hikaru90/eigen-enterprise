import type { AllowlistEntry, AllowlistStore, SessionStore } from './stores'
import { and, eq } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { kernelGatewayAllowlist, kernelGatewaySessions } from '$lib/server/db/gateway.schema'

export class DbAllowlistStore implements AllowlistStore {
  constructor(private readonly db: AppDatabase) {}

  async isAllowed(platform: string, externalUserId: string): Promise<boolean> {
    const rows = await this.db
      .select({ principalId: kernelGatewayAllowlist.principalId })
      .from(kernelGatewayAllowlist)
      .where(
        and(
          eq(kernelGatewayAllowlist.platform, platform),
          eq(kernelGatewayAllowlist.externalUserId, externalUserId),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  async principalFor(platform: string, externalUserId: string): Promise<string | null> {
    const rows = await this.db
      .select({ principalId: kernelGatewayAllowlist.principalId })
      .from(kernelGatewayAllowlist)
      .where(
        and(
          eq(kernelGatewayAllowlist.platform, platform),
          eq(kernelGatewayAllowlist.externalUserId, externalUserId),
        ),
      )
      .limit(1)
    return rows[0]?.principalId ?? null
  }

  async add(platform: string, externalUserId: string, principalId: string): Promise<void> {
    await this.db
      .insert(kernelGatewayAllowlist)
      .values({ platform, externalUserId, principalId })
      .onConflictDoUpdate({
        target: [kernelGatewayAllowlist.platform, kernelGatewayAllowlist.externalUserId],
        set: { principalId },
      })
  }

  async remove(platform: string, externalUserId: string): Promise<void> {
    await this.db
      .delete(kernelGatewayAllowlist)
      .where(
        and(
          eq(kernelGatewayAllowlist.platform, platform),
          eq(kernelGatewayAllowlist.externalUserId, externalUserId),
        ),
      )
  }

  async list(): Promise<AllowlistEntry[]> {
    return this.db
      .select({
        platform: kernelGatewayAllowlist.platform,
        externalUserId: kernelGatewayAllowlist.externalUserId,
        principalId: kernelGatewayAllowlist.principalId,
      })
      .from(kernelGatewayAllowlist)
  }
}

export class DbSessionStore implements SessionStore {
  constructor(private readonly db: AppDatabase) {}

  async touch(
    platform: string,
    externalChatId: string,
    principalId: string,
  ): Promise<{ id: string }> {
    const rows = await this.db
      .insert(kernelGatewaySessions)
      .values({ platform, externalChatId, principalId })
      .onConflictDoUpdate({
        target: [kernelGatewaySessions.platform, kernelGatewaySessions.externalChatId],
        set: { principalId, lastSeenAt: new Date() },
      })
      .returning({ id: kernelGatewaySessions.id })
    return rows[0]
  }

  async get(
    platform: string,
    externalChatId: string,
  ): Promise<{ id: string; principalId: string } | null> {
    const rows = await this.db
      .select({ id: kernelGatewaySessions.id, principalId: kernelGatewaySessions.principalId })
      .from(kernelGatewaySessions)
      .where(
        and(
          eq(kernelGatewaySessions.platform, platform),
          eq(kernelGatewaySessions.externalChatId, externalChatId),
        ),
      )
      .limit(1)
    return rows[0] ?? null
  }
}
