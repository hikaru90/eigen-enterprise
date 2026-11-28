import type { AuditClass, ToolContext, ToolDescriptor, ToolPrincipal } from './types'
import type { VcsCommitter } from './vcs'
import type { ZodType } from 'zod'
import { randomUUID } from 'node:crypto'
import { getCurrentTraceGroupId } from '../server/activity/trace-context'
import { redactForLog } from '../server/observability/redact-for-log'
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
import { isCompanyModuleName } from './manifest-schema'
import { moduleInactiveError, type ActivationStore } from './modules'
import { assertWellFormedPrincipal, attributionOf, provenanceOf } from './principals'

/**
 * Runs one tool handler inside its principal's scope — for a person (their own
 * call, or the brain acting as them) the row-level-security session of THAT
 * person, whatever the surrounding request carries (a Telegram poll has none;
 * a web turn has the signed-in person's). Injected by the composition root
 * (src/lib/server/kernel/principal-scope.ts); the registry does no IO itself.
 */
export type PrincipalScope = <T>(principal: ToolPrincipal, run: () => Promise<T>) => Promise<T>

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
  /** Handler scope per principal (row-level security). Absent (bare in-memory usage, unit tests): handlers run as called. */
  principalScope?: PrincipalScope
}

export type KernelToolFilter = {
  module?: string
  auditClass?: AuditClass
}

function parseInput(schema: ZodType, input: unknown, toolName: string): unknown {
  const result = schema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join('; ')
    throw new KernelError('invalid_input', `invalid input for tool ${toolName}: ${detail}`, {
      tool: toolName,
      issues,
    })
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
  private readonly dynamicallyGated = new Set<string>()
  private readonly eventSink: EventSink
  private readonly activationStore: ActivationStore | undefined
  private readonly approvalPolicy: ApprovalPolicy
  private readonly approvalStore: ApprovalStore
  private readonly vcsCommitter: VcsCommitter | null
  private readonly principalScope: PrincipalScope | undefined

  constructor(options: KernelRegistryOptions = {}) {
    this.eventSink = options.eventSink ?? new InMemoryEventSink()
    this.activationStore = options.activationStore
    this.approvalPolicy = options.approvalPolicy ?? new StaticApprovalPolicy(new Set())
    this.approvalStore = options.approvalStore ?? new InMemoryApprovalStore()
    this.vcsCommitter = options.vcsCommitter === undefined ? null : options.vcsCommitter
    this.principalScope = options.principalScope
  }

  /**
   * Registers a tool. `gated` puts it on the approval-gated list for its
   * lifetime (a company module's `approval: mode` tool, §4.5) — the same gate
   * the policy applies to the compiled-in gated tools.
   */
  register(descriptor: ToolDescriptor, options: { gated?: boolean } = {}): void {
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
        throw new Error(
          `tool ${descriptor.name} is a read tool; only a tool that changes something can be always-ask (approvalAlways)`,
        )
      }
      if (descriptor.approvalRisk === undefined) {
        throw new Error(
          `always-ask tool ${descriptor.name} declares no approvalRisk; every gated tool must declare one`,
        )
      }
    }
    if (options.gated === true) {
      if (descriptor.auditClass === 'read') {
        throw new Error(`tool ${descriptor.name} is a read tool; only a tool that changes something can be approval-gated`)
      }
      if (descriptor.approvalRisk === undefined) {
        throw new Error(`approval-gated tool ${descriptor.name} declares no approvalRisk; every gated tool must declare one`)
      }
    }
    this.approvalPolicy.validateTool?.(descriptor)
    this.tools.set(descriptor.name, descriptor)
    if (options.gated === true) this.dynamicallyGated.add(descriptor.name)
  }

  /**
   * Removes a tool (a company module redeployed with other tools, or removed).
   * Only tools registered as removable — a company module's proxies — may go;
   * the compiled-in surface never shrinks at runtime.
   */
  unregister(name: string): void {
    const descriptor = this.tools.get(name)
    if (!descriptor) throw new KernelError('unknown_tool', `unknown tool: ${name}`)
    if (!isCompanyModuleName(descriptor.module)) {
      throw new Error(`tool ${name} belongs to core module ${descriptor.module}; only a company module's tools can be unregistered`)
    }
    this.tools.delete(name)
    this.dynamicallyGated.delete(name)
  }

  /** True when the tool waits on the approval mode because it was registered gated. */
  isDynamicallyGated(name: string): boolean {
    return this.dynamicallyGated.has(name)
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
    // A delegated principal is the person via the brain — nothing else may carry `via`.
    assertWellFormedPrincipal(ctx.principal)

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
    // Their input is validated first: a person is never asked to approve a call that cannot run.
    if (descriptor.approvalAlways === true) {
      parseInput(descriptor.inputSchema, input, name)
      await this.alwaysAskGate(name, input, ctx)
    }
    const decision =
      descriptor.auditClass === 'read' || descriptor.approvalAlways === true
        ? 'pass'
        : await this.approvalPolicy.decide(descriptor, ctx, { gated: this.dynamicallyGated.has(name) })
    if (decision === 'auto_approved') {
      await emitKernelEvent(this.eventSink, {
        type: 'approval.auto_approved',
        principalId: ctx.principal.id,
        source: moduleSource(descriptor.module),
        payload: {
          tool: name,
          approvalRisk: descriptor.approvalRisk,
          ...provenanceOf(ctx.principal),
        },
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
        // Only a redacted copy is stored (and shown to the approver): secret-named fields
        // (passwords, keys, tokens, secrets) never land in the approval record. The approved
        // call runs on its own input when it is made again.
        const created = await this.approvalStore.create({
          id: randomUUID(),
          toolName: name,
          input: redactForLog(input),
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
      result = this.principalScope
        ? await this.principalScope(ctx.principal, () => descriptor.handler(ctx, parsed))
        : await descriptor.handler(ctx, parsed)
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
      await this.vcsCommitter.commit(`tool ${name} by ${attributionOf(ctx.principal)}`)
    }

    return result
  }

  /**
   * The always-on approval wall (ToolDescriptor.approvalAlways): one decided
   * approval covers exactly one call with exactly the approved input, and is
   * consumed atomically before the handler runs. Anything else waits.
   */
  private async alwaysAskGate(name: string, input: unknown, ctx: ToolContext): Promise<void> {
    // Stored inputs are redacted (secret-named fields), so the call is matched on its redacted form:
    // an approval covers exactly its input apart from the secrets' values.
    const redacted = redactForLog(input)
    const open = (await this.approvalStore.openFor(name, ctx.principal.id)).filter((r) =>
      sameApprovalInput(r.input, redacted),
    )
    for (const approved of open.filter((r) => r.status === 'approved')) {
      if (await this.approvalStore.consume(approved.id)) return
    }
    const pending = open.find((r) => r.status === 'pending')
    if (pending) {
      throw new KernelError('approval_required', `tool ${name} is awaiting approval`, {
        approvalId: pending.id,
        tool: name,
      })
    }
    const created = await this.approvalStore.create({
      id: randomUUID(),
      toolName: name,
      input: redacted,
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
        // The run this call belongs to (plan/traces-phone-home.md T0): joins it to the run's model calls.
        ...traceIdOf(getCurrentTraceGroupId()),
        // Provenance: the actor is the person (principalId); `via` says the brain carried the call.
        ...provenanceOf(ctx.principal),
      },
    })
  }
}

function traceIdOf(traceId: string | undefined): { traceId?: string } {
  return traceId === undefined ? {} : { traceId }
}

/** Shared instance; collaborators are wired wherever tools get registered. */
export const kernelRegistry = new KernelRegistry()
