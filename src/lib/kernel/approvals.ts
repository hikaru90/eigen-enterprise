import type { ToolContext, ToolDescriptor } from './types'
import { randomUUID } from 'node:crypto'

export type ApprovalStatus = 'pending' | 'approved' | 'denied'

export type ApprovalRequest = {
  id: string
  toolName: string
  input: unknown
  principalId: string
  status: ApprovalStatus
  decidedBy?: string
  decidedAt?: string
}

export type ApprovalPolicy = {
  requiresApproval(tool: ToolDescriptor, ctx: ToolContext): boolean
}

/** Static policy: approval required exactly for the tool names given. */
export class StaticApprovalPolicy implements ApprovalPolicy {
  constructor(private readonly alwaysRequire: ReadonlySet<string>) {}

  requiresApproval(tool: ToolDescriptor, _ctx: ToolContext): boolean {
    return this.alwaysRequire.has(tool.name)
  }
}

export type ApprovalStore = {
  create(req: ApprovalRequest): Promise<ApprovalRequest>
  decide(id: string, status: 'approved' | 'denied', decidedBy: string): Promise<ApprovalRequest>
  listPending(): Promise<ApprovalRequest[]>
  /**
   * Most recent request for a tool+principal pair (any status), or null.
   * The registry's approval gate uses this to let an approved decision through.
   */
  latestFor(toolName: string, principalId: string): Promise<ApprovalRequest | null>
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly requests = new Map<string, ApprovalRequest>()

  async create(req: ApprovalRequest): Promise<ApprovalRequest> {
    const stored: ApprovalRequest = { ...req }
    this.requests.set(stored.id, stored)
    return stored
  }

  async decide(id: string, status: 'approved' | 'denied', decidedBy: string): Promise<ApprovalRequest> {
    const existing = this.requests.get(id)
    if (!existing) throw new Error(`unknown approval request: ${id}`)
    const decided: ApprovalRequest = {
      ...existing,
      status,
      decidedBy,
      decidedAt: new Date().toISOString(),
    }
    this.requests.set(id, decided)
    return decided
  }

  async listPending(): Promise<ApprovalRequest[]> {
    return [...this.requests.values()].filter((r) => r.status === 'pending')
  }

  async latestFor(toolName: string, principalId: string): Promise<ApprovalRequest | null> {
    // Map iteration is insertion order, so the last match is the most recently created.
    let latest: ApprovalRequest | null = null
    for (const req of this.requests.values()) {
      if (req.toolName === toolName && req.principalId === principalId) latest = req
    }
    return latest
  }
}

/** Convenience constructor for stores that need to mint request ids. */
export function newApprovalRequest(params: {
  toolName: string
  input: unknown
  principalId: string
}): ApprovalRequest {
  return {
    id: randomUUID(),
    toolName: params.toolName,
    input: params.input,
    principalId: params.principalId,
    status: 'pending',
  }
}
