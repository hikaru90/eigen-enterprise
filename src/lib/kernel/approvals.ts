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

/**
 * require = the call waits for an owner decision; pass = runs, not gated;
 * auto_approved = would be gated under "ask" but the owner's mode lets it run
 * (the registry records an `approval.auto_approved` event for visibility).
 */
export type ApprovalDecision = 'require' | 'pass' | 'auto_approved'

export type ApprovalPolicy = {
  decide(tool: ToolDescriptor, ctx: ToolContext): ApprovalDecision | Promise<ApprovalDecision>
  /** Called on registration; throws to fail the load (e.g. missing metadata). */
  validateTool?(tool: ToolDescriptor): void
}

/** Static policy: approval required exactly for the tool names given. */
export class StaticApprovalPolicy implements ApprovalPolicy {
  constructor(private readonly alwaysRequire: ReadonlySet<string>) {}

  requiresApproval(tool: ToolDescriptor, _ctx: ToolContext): boolean {
    return this.alwaysRequire.has(tool.name)
  }

  decide(tool: ToolDescriptor, ctx: ToolContext): ApprovalDecision {
    return this.requiresApproval(tool, ctx) ? 'require' : 'pass'
  }
}

export const APPROVAL_MODES = ['ask', 'reasonable', 'allow_all'] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value)
}

/** Company-wide approval mode (one row, seeded 'ask' by migration 0090). */
export type ApprovalModeStore = {
  get(): Promise<ApprovalMode>
  set(mode: ApprovalMode, updatedBy: string): Promise<ApprovalMode>
}

export class InMemoryApprovalModeStore implements ApprovalModeStore {
  constructor(private mode: ApprovalMode) {}
  async get(): Promise<ApprovalMode> {
    return this.mode
  }
  async set(mode: ApprovalMode, _updatedBy: string): Promise<ApprovalMode> {
    this.mode = mode
    return mode
  }
}

/**
 * The owner-chosen approval mode over the gated tool list:
 *   ask        — exactly the gated list waits (the original static behaviour);
 *   reasonable — a gated tool waits unless its DECLARED approvalRisk is 'internal';
 *   allow_all  — nothing waits; gated tools resolve to 'auto_approved' (still audited).
 * Every gated tool must declare approvalRisk; registering one without it throws.
 */
export class ModeAwareApprovalPolicy implements ApprovalPolicy {
  constructor(
    private readonly gated: ReadonlySet<string>,
    private readonly modeStore: ApprovalModeStore,
  ) {}

  validateTool(tool: ToolDescriptor): void {
    if (this.gated.has(tool.name) && tool.approvalRisk === undefined) {
      throw new Error(
        `approval-gated tool ${tool.name} declares no approvalRisk; every gated tool must declare one`,
      )
    }
  }

  async decide(tool: ToolDescriptor, _ctx: ToolContext): Promise<ApprovalDecision> {
    if (!this.gated.has(tool.name)) return 'pass'
    this.validateTool(tool)
    const mode = await this.modeStore.get()
    switch (mode) {
      case 'ask':
        return 'require'
      case 'reasonable':
        return tool.approvalRisk === 'internal' ? 'auto_approved' : 'require'
      case 'allow_all':
        return 'auto_approved'
    }
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
