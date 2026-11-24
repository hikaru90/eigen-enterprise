import { z, type ZodType } from 'zod'
import {
  kernelModuleId,
  providedToolName,
  toolNamespace,
  type ModuleManifestV1,
  type ModuleProvidedTool,
} from '../../../../contracts/module-manifest'
import type { ModuleManifest } from '../modules'
import type { ToolContext, ToolDescriptor } from '../types'

/**
 * Proxy tools (plan/phase-upgrades-u2.md §4.5): each tool a module provides
 * becomes a registry ToolDescriptor `x_<id_>.<tool>` of module `x-<id>`, so it
 * reaches MCP, the CLI, OpenAPI and the agent like any tool, through the one
 * execution path (activation → roles → approval → input → handler → output →
 * audit). The handler forwards to the module's live session.
 */

const PLACEHOLDER = /\{(input|output)\.([A-Za-z_][A-Za-z0-9_]*)\}/g

function shown(value: unknown): string {
  if (value === undefined || value === null) return '…'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Renders an activity template (`Created invoice {output.number} for
 * {input.customer}`): placeholders only (the manifest schema checked them),
 * values as text. On a failed call `output` is undefined and its placeholders
 * read "…".
 */
export function renderActivity(template: string, input: unknown, output: unknown): string {
  const side = { input, output } as Record<'input' | 'output', unknown>
  return template.replace(PLACEHOLDER, (_whole, which: 'input' | 'output', key: string) => {
    const holder = side[which]
    return shown(holder && typeof holder === 'object' ? (holder as Record<string, unknown>)[key] : undefined)
  })
}

/** A JSON Schema of the manifest as a zod schema (the manifest schema already proved it converts). */
export function schemaOf(jsonSchema: Record<string, unknown>): ZodType {
  return z.fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0])
}

/** The kernel manifest of a company module: id `x-<id>`, namespaces `x-<id>` and `x_<id_>`. */
export function kernelManifestOf(manifest: ModuleManifestV1): ModuleManifest {
  const id = kernelModuleId(manifest.id)
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    toolNamespaces: [id, toolNamespace(manifest.id)],
    tools: manifest.provides.tools.map((t) => providedToolName(manifest.id, t.name)),
    permissions: { roles: ['admin', 'member', 'agent'] },
  }
}

export type ProxyInvoke = (
  tool: ModuleProvidedTool,
  ctx: ToolContext,
  input: unknown,
) => Promise<unknown>

export type ProxyTool = { descriptor: ToolDescriptor; gated: boolean }

/** The proxy descriptors of a manifest's provided tools. */
export function proxyTools(manifest: ModuleManifestV1, invoke: ProxyInvoke): ProxyTool[] {
  const module = kernelModuleId(manifest.id)
  return manifest.provides.tools.map((tool) => {
    const descriptor: ToolDescriptor = {
      name: providedToolName(manifest.id, tool.name),
      module,
      summary: `${tool.summary} (${manifest.name}, a company module)`,
      inputSchema: schemaOf(tool.input),
      outputSchema: schemaOf(tool.output),
      permission: { roles: [...tool.roles] },
      auditClass: tool.auditClass,
      ...(tool.approvalRisk === undefined ? {} : { approvalRisk: tool.approvalRisk }),
      ...(tool.approval === 'always' && tool.auditClass !== 'read' ? { approvalAlways: true as const } : {}),
      ...(tool.activity === undefined
        ? {}
        : { activity: (input: unknown, output: unknown) => renderActivity(tool.activity!, input, output) }),
      handler: (ctx, input) => invoke(tool, ctx, input),
    }
    return { descriptor, gated: tool.approval === 'mode' && tool.auditClass !== 'read' }
  })
}
