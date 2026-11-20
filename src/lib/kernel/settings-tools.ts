import type { ApprovalModeStore } from './approvals'
import type { ToolContext, ToolDescriptor } from './types'
import { z } from 'zod'
import { APPROVAL_MODES } from './approvals'
import { isViaBrain } from './principals'

/**
 * The agent's reach beyond modules (Contribute d80e155d): who and what it is
 * running as (kernel.whoami), the company's settings (settings.get), and an
 * explicit allowlist of settings it may change (settings.update) — always
 * behind a person's approval, whatever the approval mode (approvalAlways).
 *
 * Outputs are declared zod objects: the registry parses every result through
 * them, so a key the schema does not name (a credential a port let slip) is
 * stripped before it reaches the model. Credentials are never in the schemas.
 */

export const KERNEL_SETTINGS_TOOL_NAMES = ['kernel.whoami', 'settings.get', 'settings.update'] as const

export const KERNEL_SETTINGS_MODULE_ID = 'kernel'

const modelInUseSchema = z.object({
  provider: z.string(),
  model: z.string(),
  routingRuleId: z.string().nullable(),
  billing: z.enum(['byok', 'platform']),
  gatewayHost: z.string(),
})
export type ModelInUse = z.infer<typeof modelInUseSchema>

const personSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: z.string().nullable(),
})
export type PersonInfo = z.infer<typeof personSchema>

const providerSchema = z.object({
  provider: z.string(),
  configured: z.boolean(),
  authType: z.string(),
  modelChat: z.string().nullable(),
  modelEmbedding: z.string().nullable(),
  ruleChat: z.string().nullable(),
  ruleEmbedding: z.string().nullable(),
})

/** The role slots a company picks a model for (embedding is fixed per install, not a setting). */
export const AI_SLOTS = ['chat', 'stt', 'tts', 'decision'] as const

const settingsViewSchema = z.object({
  company: z.object({ name: z.string().nullable(), hasLogo: z.boolean() }),
  ai: z.object({
    /** Settings → AI: "Use eigenInference" (CB1). Off = the company's own key (the providers below). */
    eigenInference: z.boolean(),
    /** The model each choosable slot runs on (a pool model; pick null = the pool's pick). */
    slots: z.array(z.object({ slot: z.enum(AI_SLOTS), model: z.string(), pick: z.string().nullable() })),
    /** The install's embedding model, fixed per install (null until the first embedding pins it). */
    embeddingModel: z.string().nullable(),
    activeProvider: z.string(),
    billing: z.enum(['byok', 'platform']),
    providers: z.array(providerSchema),
  }),
})
/** The company settings a port reads (no credentials: the schema has no place for them). */
export type SettingsView = z.infer<typeof settingsViewSchema>

/** The allowlist: the only settings settings.update can change. */
export const settingChangeSchema = z.discriminatedUnion('setting', [
  z.object({ setting: z.literal('company_name'), value: z.string().min(1) }),
  z.object({ setting: z.literal('ai_active_provider'), value: z.enum(['eurouter', 'openrouter']) }),
  z.object({
    setting: z.literal('ai_chat_model'),
    provider: z.string().min(1),
    value: z.string().min(1),
  }),
  z.object({ setting: z.literal('ai_chat_routing_rule'), value: z.string().min(1) }),
  z.object({ setting: z.literal('ai_use_eigen_inference'), value: z.boolean() }),
  z.object({ setting: z.literal('ai_slot_model'), slot: z.enum(AI_SLOTS), value: z.string().min(1) }),
])
export type SettingChange = z.infer<typeof settingChangeSchema>

const UPDATABLE: ReadonlyArray<{ setting: SettingChange['setting']; description: string }> = [
  { setting: 'company_name', description: 'The company name every page shows (Settings → Company).' },
  {
    setting: 'ai_active_provider',
    description: 'Which saved AI provider the company runs on: eurouter or openrouter (Settings → AI provider).',
  },
  {
    setting: 'ai_chat_model',
    description:
      'The chat model of a saved provider outside the model pool (not EUrouter, not OpenRouter — OpenRouter runs ai_slot_model): {provider, value: model name}.',
  },
  {
    setting: 'ai_chat_routing_rule',
    description: 'The EUrouter chat routing rule id (EUrouter routes by rule, not model name).',
  },
  {
    setting: 'ai_use_eigen_inference',
    description:
      'Settings → AI, "Use eigenInference": true = every model call runs on eigenInference; false = on the company’s own key.',
  },
  {
    setting: 'ai_slot_model',
    description:
      'The model a role slot runs on: {slot: chat | stt | tts | decision, value: a model from the curated pool}. settings.get lists each slot; embedding is fixed per install.',
  },
]

/** Settings areas the agent does not change through settings.update, and where they live. */
const ELSEWHERE: ReadonlyArray<{ area: string; how: string }> = [
  { area: 'Plugins (modules)', how: 'kernel.module_list / kernel.module_activate / kernel.module_deactivate' },
  { area: 'Members and groups', how: 'the members.* tools (invite, set_role, groups)' },
  {
    area: 'Approval mode',
    how: 'Owner only, in Settings → Approvals (the agent never changes its own approval wall)',
  },
  {
    area: 'AI provider keys, passkeys, API keys, backups, account email',
    how: 'The person themselves in Settings — credentials never pass through the agent',
  },
  { area: 'Company logo, sharing proposals with the makers', how: 'Settings → Company' },
]

const getOutputSchema = settingsViewSchema.extend({
  approvals: z.object({ mode: z.enum(APPROVAL_MODES) }),
  updatable: z.array(z.object({ setting: z.string(), description: z.string() })),
  elsewhere: z.array(z.object({ area: z.string(), how: z.string() })),
})

const whoamiOutputSchema = z.object({
  you: z.object({
    principalId: z.string(),
    kind: z.enum(['human', 'agent', 'service']),
    via: z.literal('brain').optional(),
    agentId: z.string().optional(),
  }),
  model: modelInUseSchema,
  modelNote: z.string(),
  company: z.object({ name: z.string().nullable() }),
  actingUser: personSchema.nullable(),
})

/** Server-side reads and writes behind the tools (live: $lib/server/settings/agent-settings). */
export type SettingsPort = {
  /** What a chat model call made under this identity resolves to now, exactly as the gateway resolves it. */
  modelFor(identityUserId: string): Promise<ModelInUse>
  person(userId: string): Promise<PersonInfo | null>
  read(): Promise<SettingsView>
  /** Applies one allowlisted change as `actorUserId`; fails loud when it cannot. */
  apply(change: SettingChange, actorUserId: string): Promise<void>
}

export type SettingsToolDeps = {
  port: SettingsPort
  approvalMode: ApprovalModeStore
}

/** The identity the call's model calls resolve under: the principal — for the brain, the person it acts as (CB3). */
function modelIdentity(ctx: ToolContext): string {
  return ctx.principal.id
}

/** The person behind the call: a person principal (themselves, or the brain acting as them), else none. */
function personOf(ctx: ToolContext): string | null {
  return ctx.principal.kind === 'human' ? ctx.principal.id : null
}

function changeSentence(change: SettingChange): string {
  switch (change.setting) {
    case 'company_name':
      return `Renamed the company to “${change.value}”`
    case 'ai_active_provider':
      return `Switched the company’s AI provider to ${change.value === 'eurouter' ? 'EUrouter' : 'OpenRouter'}`
    case 'ai_chat_model':
      return `Set the chat model of ${change.provider} to ${change.value}`
    case 'ai_chat_routing_rule':
      return 'Set the EUrouter chat routing rule'
    case 'ai_use_eigen_inference':
      return change.value ? 'Switched the company to eigenInference' : 'Switched the company to its own AI key'
    case 'ai_slot_model':
      return `Set the ${change.slot} model to ${change.value}`
  }
}

export function createSettingsTools(deps: SettingsToolDeps): ToolDescriptor[] {
  const readAll = async () => ({
    ...(await deps.port.read()),
    approvals: { mode: await deps.approvalMode.get() },
    updatable: UPDATABLE.map((u) => ({ ...u })),
    elsewhere: ELSEWHERE.map((e) => ({ ...e })),
  })

  return [
    {
      name: 'kernel.whoami',
      module: KERNEL_SETTINGS_MODULE_ID,
      summary:
        'Who and what you are running as right now: the AI provider and model your model calls resolve to (resolved live, the way the gateway resolves them), the company, and the person you are acting for. Call it when anyone asks which model or provider you use.',
      auditClass: 'read',
      inputSchema: z.object({}),
      outputSchema: whoamiOutputSchema,
      // Every member may ask the brain who and what it runs as.
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx) => {
        const person = personOf(ctx)
        const [model, settings, actingUser] = await Promise.all([
          deps.port.modelFor(modelIdentity(ctx)),
          deps.port.read(),
          person === null ? Promise.resolve(null) : deps.port.person(person),
        ])
        return {
          you: {
            principalId: ctx.principal.id,
            kind: ctx.principal.kind,
            // Provenance: answering through the company brain, as this person.
            ...(isViaBrain(ctx.principal) ? { via: ctx.principal.via, agentId: ctx.principal.agentId } : {}),
          },
          model,
          modelNote:
            'Resolved now through the company’s AI provider, exactly as your model calls are. It changes when the owner changes the provider or model in Settings → AI provider.',
          company: { name: settings.company.name },
          actingUser,
        }
      },
    },
    {
      name: 'settings.get',
      module: KERNEL_SETTINGS_MODULE_ID,
      summary:
        'Read the company settings: company name and logo, the AI provider and models (never keys), the approval mode, which settings settings.update can change, and where every other settings area is managed.',
      auditClass: 'read',
      inputSchema: z.object({}),
      outputSchema: getOutputSchema,
      permission: { roles: ['admin', 'agent'] },
      handler: async () => readAll(),
    },
    {
      name: 'settings.update',
      module: KERNEL_SETTINGS_MODULE_ID,
      summary:
        'Change one company setting from the allowlist (company_name, ai_active_provider, ai_chat_model, ai_chat_routing_rule). Every change waits for the owner’s approval, in every approval mode; the approval covers exactly this one change. Returns the settings after the change.',
      auditClass: 'mutate',
      activity: (input: SettingChange) => changeSentence(input),
      approvalRisk: 'internal',
      approvalAlways: true,
      inputSchema: settingChangeSchema,
      outputSchema: getOutputSchema,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const change = settingChangeSchema.parse(input)
        await deps.port.apply(change, ctx.principal.id)
        return readAll()
      },
    },
  ]
}
