import { randomUUID } from 'node:crypto'
import type { ZodType } from 'zod'
import {
  InMemoryApprovalStore,
  StaticApprovalPolicy,
  type ApprovalPolicy,
  type ApprovalStore,
} from './approvals'
import { moduleSource } from './cloudevents'
import { KernelError } from './errors'
import { emitKernelEvent, InMemoryEventSink, type EventSink } from './events'
import type { ActivationStore } from './modules'
import type { AuditClass, ToolContext, ToolDescriptor } from './types'
import type { VcsCommitter } from './vcs'

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
      if (!active) {
        throw new KernelError(
          'module_inactive',
          `module ${descriptor.module} is not active; cannot execute ${name}`,
        )
      }
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
    if (descriptor.auditClass !== 'read' && this.approvalPolicy.requiresApproval(descriptor, ctx)) {
      const latest = await this.approvalStore.latestFor(name, ctx.principal.id)
      if (latest?.status === 'pending') {
        throw new KernelError('approval_required', `tool ${name} is awaiting approval`)
      }
      if (latest?.status !== 'approved') {
        await this.approvalStore.create({
          id: randomUUID(),
          toolName: name,
          input,
          principalId: ctx.principal.id,
          status: 'pending',
        })
        throw new KernelError('approval_required', `tool ${name} requires approval`)
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
      await this.audit(descriptor, ctx, ok, error, Date.now() - startedAtMs)
      throw err
    }

    // (e) audit.
    await this.audit(descriptor, ctx, ok, error, Date.now() - startedAtMs)

    // (f) mutate tools that succeeded get a vcs commit.
    if (descriptor.auditClass === 'mutate' && this.vcsCommitter) {
      await this.vcsCommitter.commit(`tool ${name} by ${ctx.principal.id}`)
    }

    return result
  }

  private async audit(
    descriptor: ToolDescriptor,
    ctx: ToolContext,
    ok: boolean,
    error: string | undefined,
    durationMs: number,
  ): Promise<void> {
    await emitKernelEvent(this.eventSink, {
      type: 'tool.executed',
      principalId: ctx.principal.id,
      source: moduleSource(descriptor.module),
      payload: {
        tool: descriptor.name,
        auditClass: descriptor.auditClass,
        ok,
        ...(error === undefined ? {} : { error }),
        durationMs,
      },
    })
  }
}

/** Shared instance; collaborators are wired wherever tools get registered. */
export const kernelRegistry = new KernelRegistry()
