import type { AuditClass, ToolContext, ToolDescriptor } from './types'
import type { VcsCommitter } from './vcs'
import type { ZodType } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  InMemoryApprovalStore,
  sameApprovalInput,
  StaticApprovalPolicy,
  type ApprovalPolicy,
  type ApprovalStore,
} from './approvals'
import { moduleSource } from './cloudevents'
import { KernelError } from './errors'
import { emitKernelEvent, InMemoryEventSink, type EventSink } from './events'
import { moduleInactiveError, type ActivationStore } from './modules'

export type KernelRegistryOptions = {
  eventSink?: EventSink
  /**
   * Module activation gate. When provided, execute() fails closed with
   * `module_inactive` unless the owning module is active. When absent
   * (bare in-memory usage, unit tests), activation gating is skipped.
   */
  activationStore?: ActivationStore
  approvalPolicy?: ApprovalPolicy
  approvalStore?: ApprovalStore
  vcsCommitter?: VcsCommitter | null
}

export type KernelToolFilter = {
  module?: string
  auditClass?: AuditClass
}

function parseInput(schema: ZodType, input: unknown, toolName: string): unknown {
  const result = schema.safeParse(input)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new KernelError('invalid_input', `invalid input for tool ${toolName}: ${detail}`)
  }
  return result.data
}

function parseOutput(schema: ZodType, output: unknown, toolName: string): unknown {
  const result = schema.safeParse(output)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new KernelError('invalid_output', `invalid output for tool ${toolName}: ${detail}`)
  }
  return result.data
}

/**
 * The single execution path for kernel tools: module activation gate ->
 * permission check -> approval gate -> input validation -> handler -> output
 * validation -> audit event -> (mutate) vcs commit.
 * All collaborators are constructor-injected; the registry itself does no IO.
 */
export class KernelRegistry {
  private readonly tools = new Map<string, ToolDescriptor>()
  private readonly eventSink: EventSink
  private readonly activationStore: ActivationStore | undefined
  private readonly approvalPolicy: ApprovalPolicy
  private readonly approvalStore: ApprovalStore
  private readonly vcsCommitter: VcsCommitter | null

  constructor(options: KernelRegistryOptions = {}) {
    this.eventSink = options.eventSink ?? new InMemoryEventSink()
    this.activationStore = options.activationStore
    this.approvalPolicy = options.approvalPolicy ?? new StaticApprovalPolicy(new Set())
    this.approvalStore = options.approvalStore ?? new InMemoryApprovalStore()
    this.vcsCommitter = options.vcsCommitter === undefined ? null : options.vcsCommitter
  }

  register(descriptor: ToolDescriptor): void {
    if (this.tools.has(descriptor.name)) {
      throw new KernelError('duplicate_tool', `tool already registered: ${descriptor.name}`)
    }
    if (descriptor.auditClass !== 'read' && typeof descriptor.activity !== 'function') {
      throw new Error(
        `tool ${descriptor.name} (${descriptor.auditClass}) declares no activity; every non-read tool must say in plain words what it did`,
      )
    }
    if (descriptor.approvalAlways === true) {
      if (descriptor.auditClass === 'read') {
        throw new Error(`tool ${descriptor.name} is a read tool; only a tool that changes something can be always-ask (approvalAlways)`)
      }
      if (descriptor.approvalRisk === undefined) {
        throw new Error(`always-ask tool ${descriptor.name} declares no approvalRisk; every gated tool must declare one`)
      }
    }
    this.approvalPolicy.validateTool?.(descriptor)
    this.tools.set(descriptor.name, descriptor)
  }

  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name)
  }

  list(filter?: KernelToolFilter): ToolDescriptor[] {
    return [...this.tools.values()].filter(
      (tool) =>
        (filter?.module === undefined || tool.module === filter.module) &&
        (filter?.auditClass === undefined || tool.auditClass === filter.auditClass),
    )
  }

  getEventSink(): EventSink {
    return this.eventSink
  }

  getApprovalStore(): ApprovalStore {
    return this.approvalStore
  }

  async execute(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const descriptor = this.tools.get(name)
    if (!descriptor) throw new KernelError('unknown_tool', `unknown tool: ${name}`)

    // (a) module activation gate: fail closed when a store is wired.
    if (this.activationStore) {
      const active = await this.activationStore.get(descriptor.module)
      if (!active) throw await moduleInactiveError(this.activationStore, descriptor.module, name)
    }

    // (b) permission: principal roles must intersect descriptor roles.
    const allowed = descriptor.permission.roles.some((role) => ctx.principal.roles.includes(role))
    if (!allowed) {
      throw new KernelError(
        'permission_denied',
        `principal ${ctx.principal.id} is not permitted to execute ${name}`,
      )
    }

    // (c) approval gate: everything non-read (mutate + external), per injected policy and existing decisions.
    // Always-ask tools bypass the policy entirely: no approval mode can wave them through.
    if (descriptor.approvalAlways === true) await this.alwaysAskGate(name, input, ctx)
    const decision =
      descriptor.auditClass === 'read' || descriptor.approvalAlways === true
        ? 'pass'
        : await this.approvalPolicy.decide(descriptor, ctx)
    if (decision === 'auto_approved') {
      await emitKernelEvent(this.eventSink, {
        type: 'approval.auto_approved',
        principalId: ctx.principal.id,
        source: moduleSource(descriptor.module),
        payload: { tool: name, approvalRisk: descriptor.approvalRisk },
      })
    }
    if (decision === 'require') {
      const latest = await this.approvalStore.latestFor(name, ctx.principal.id)
      if (latest?.status === 'pending') {
        throw new KernelError('approval_required', `tool ${name} is awaiting approval`, {
          approvalId: latest.id,
          tool: name,
        })
      }
      if (latest?.status !== 'approved') {
        const created = await this.approvalStore.create({
          id: randomUUID(),
          toolName: name,
          input,
          principalId: ctx.principal.id,
          status: 'pending',
        })
        // The request id travels with the gate so surfaces can decide it directly.
        throw new KernelError('approval_required', `tool ${name} requires approval`, {
          approvalId: created.id,
          tool: name,
        })
      }
    }

    // (d) input validation + handler execution + output contract.
    const parsed = parseInput(descriptor.inputSchema, input, name)
    const startedAtMs = Date.now()
    let ok = true
    let error: string | undefined
    let result: unknown
    try {
      result = await descriptor.handler(ctx, parsed)
      // validated before audit so a contract breach is recorded as ok:false.
      if (descriptor.outputSchema) result = parseOutput(descriptor.outputSchema, result, name)
    } catch (err) {
      ok = false
      error = err instanceof Error ? err.message : String(err)
      await this.audit(descriptor, ctx, parsed, undefined, ok, error, Date.now() - startedAtMs)
      throw err
    }

    // (e) audit.
    await this.audit(descriptor, ctx, parsed, result, ok, error, Date.now() - startedAtMs)

    // (f) mutate tools that succeeded get a vcs commit.
    if (descriptor.auditClass === 'mutate' && this.vcsCommitter) {
      await this.vcsCommitter.commit(`tool ${name} by ${ctx.principal.id}`)
    }

    return result
  }

  /**
   * The always-on approval wall (ToolDescriptor.approvalAlways): one decided
   * approval covers exactly one call with exactly the approved input, and is
   * consumed atomically before the handler runs. Anything else waits.
   */
  private async alwaysAskGate(name: string, input: unknown, ctx: ToolContext): Promise<void> {
    const latest = await this.approvalStore.latestFor(name, ctx.principal.id)
    if (latest?.status === 'pending') {
      throw new KernelError('approval_required', `tool ${name} is awaiting approval`, {
        approvalId: latest.id,
        tool: name,
      })
    }
    if (
      latest?.status === 'approved' &&
      latest.consumedAt === undefined &&
      sameApprovalInput(latest.input, input) &&
      (await this.approvalStore.consume(latest.id))
    ) {
      return
    }
    const created = await this.approvalStore.create({
      id: randomUUID(),
      toolName: name,
      input,
      principalId: ctx.principal.id,
      status: 'pending',
    })
    throw new KernelError('approval_required', `tool ${name} requires approval`, {
      approvalId: created.id,
      tool: name,
    })
  }

  private async audit(
    descriptor: ToolDescriptor,
    ctx: ToolContext,
    input: unknown,
    output: unknown,
    ok: boolean,
    error: string | undefined,
    durationMs: number,
  ): Promise<void> {
    // A throwing activity is a contract breach of the tool, recorded loudly in
    // the audit trail — it never changes the tool's own result.
    let activity: string | undefined
    let activityError: string | undefined
    if (descriptor.activity) {
      try {
        activity = descriptor.activity(input, ok ? output : undefined)
        if (typeof activity !== 'string' || activity.length === 0) {
          throw new Error('activity must return a non-empty sentence')
        }
      } catch (err) {
        activity = undefined
        activityError = `activity of ${descriptor.name} failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    await emitKernelEvent(this.eventSink, {
      type: 'tool.executed',
      principalId: ctx.principal.id,
      source: moduleSource(descriptor.module),
      payload: {
        tool: descriptor.name,
        auditClass: descriptor.auditClass,
        ok,
        ...(error === undefined ? {} : { error }),
        ...(activity === undefined ? {} : { activity }),
        ...(activityError === undefined ? {} : { activityError }),
        durationMs,
      },
    })
  }
}

/** Shared instance; collaborators are wired wherever tools get registered. */
export const kernelRegistry = new KernelRegistry()
