import { describe, expect, it, vi } from 'vitest'

// Hermetic: private-env-dependent failure paths must not depend on the
// developer machine's .env (placeholders would turn fail-loud assertions
// into fetch-against-garbage).
vi.mock('$env/dynamic/private', () => ({ default: {}, env: {} }))

vi.mock('$lib/server/mcp/tools', () => ({
  runCaptureThoughtTool: vi.fn(),
  runRetrieveThoughtsTool: vi.fn(async () => ({ count: 0, results: [] })),
  runListProjectsTool: vi.fn(),
  runGetProjectTimelineTool: vi.fn(),
  runListTextFilesTool: vi.fn(),
  runGetTextFileTool: vi.fn(),
  runSearchTextFilesTool: vi.fn(),
}))

// Hermetic brand store for the approval-flow spec: buildKernel wires the
// default (DB-backed) brand store; the visual_set_activate gate test below
// swaps in one shared in-memory store so no DATABASE_URL is needed.
vi.mock('./brand/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./brand/store')>()
  const singleton = new actual.InMemoryBrandStore()
  return { ...actual, defaultBrandStore: () => singleton }
})

import { InMemoryApprovalModeStore, InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import type { Brain } from '$lib/kernel/gateway'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import type { ToolContext } from '$lib/kernel/types'
import type { AppDatabase } from '$lib/server/db/context'
import { REQUIRED_VISUAL_ROLES } from './brand/store'
import {
  APPROVAL_REQUIRED_TOOLS,
  bootstrapChatGateway,
  bootstrapKernel,
  buildKernel,
  callContextsFromMessages,
  callLogToMessages,
  moduleManifests,
} from './index'
import { createChannel, listMessages, openDm } from './messages/service'
import { fixture as messagesFixture } from './messages/test-fixtures'
import { bootstrapOrchestrator } from './orchestrator/bootstrap'
import { OrchestratorBrain } from './orchestrator/brain'

/** Company email lives in the database; in unit tests it is not set up. */
vi.mock('$lib/server/mail', async () => {
  const { MailNotConfiguredError } = await import('$lib/server/mail/company-mail')
  return {
    companyMail: () => ({
      send: async () => {
        throw new MailNotConfiguredError()
      },
    }),
  }
})

const ctx: ToolContext = {
  principal: { id: 'principal-1', kind: 'human', roles: ['admin', 'agent'] },
  requestId: 'req-1',
}

function makeInMemoryKernel() {
  const activations = new InMemoryActivationStore()
  const eventSink = new InMemoryEventSink()
  const approvalStore = new InMemoryApprovalStore()
  const approvalMode = new InMemoryApprovalModeStore('ask')
  const kernel = buildKernel({ activations, eventSink, approvalStore, approvalMode, vcsCommitter: null })
  return { kernel, activations, eventSink, approvalStore, approvalMode }
}

describe('buildKernel wires the owner-chosen approval mode', () => {
  it('uses ModeAwareApprovalPolicy over the kernel mode store: allow_all lets email.send_mail through, audited', async () => {
    const { kernel, approvalStore, approvalMode, eventSink } = makeInMemoryKernel()
    expect(kernel.approvalMode).toBe(approvalMode)
    await kernel.activations.set('email', true)
    await approvalMode.set('allow_all', 'owner')
    const input = { to: 'a@b.co', subject: 's', html: 'h', text: 't' }
    // the handler runs (company mail unconfigured in tests) instead of halting at approval
    await expect(kernel.registry.execute('email.send_mail', input, ctx)).rejects.not.toMatchObject({
      code: 'approval_required',
    })
    expect(await approvalStore.listPending()).toHaveLength(0)
    expect(eventSink.events.map((e) => e.type)).toEqual(['approval.auto_approved', 'tool.executed'])
  })

  it('every gated tool registered by buildKernel declares its approvalRisk', () => {
    const { kernel } = makeInMemoryKernel()
    const declared = Object.fromEntries(
      [...APPROVAL_REQUIRED_TOOLS]
        .filter((name) => kernel.registry.get(name))
        .map((name) => [name, kernel.registry.get(name)?.approvalRisk]),
    )
    expect(declared).toEqual({
      'assistant.conversation_rename': 'internal',
      'brand.set_activate': 'public',
      'brand.social_post_delete': 'destructive',
      'brand.visual_set_activate': 'public',
      'calendar.accept_proposal': 'external',
      'calendar.create_event': 'internal',
      'calendar.delete_event': 'destructive',
      'calendar.dismiss_proposal': 'internal',
      'calendar.set_default_visibility': 'internal',
      'calendar.update_event': 'internal',
      'calls.brain_set': 'internal',
      'calls.brain_share_answer': 'internal',
      'calls.invite_guests': 'external',
      'calls.remove_guest': 'internal',
      'calls.schedule': 'external',
      'calls.start': 'internal',
      'contacts.create': 'internal',
      'contacts.delete': 'destructive',
      'contacts.import': 'internal',
      'contacts.log_contact': 'internal',
      'contacts.set_company_default_visibility': 'internal',
      'contacts.set_my_default_visibility': 'internal',
      'contacts.set_shared': 'internal',
      'contacts.share_many': 'internal',
      'contacts.update': 'internal',
      'contribute.propose': 'internal',
      'contribute.vote': 'internal',
      'contribute_hub.revoke_install': 'destructive',
      'demo.seed_company': 'public',
      'drive.archive': 'internal',
      'drive.create_document': 'internal',
      'drive.create_folder': 'internal',
      'drive.delete_forever': 'destructive',
      'drive.move': 'internal',
      'drive.rename': 'internal',
      'drive.restore': 'internal',
      'drive.restore_revision': 'internal',
      'drive.save_file_bytes': 'internal',
      'drive.set_sharing': 'internal',
      'drive.trash': 'internal',
      'drive.unarchive': 'internal',
      'drive.upload': 'internal',
      'drive.write_text': 'internal',
      'email.contact_add': 'internal',
      'email.contact_remove': 'destructive',
      'email.domain_add': 'internal',
      'email.domain_delete': 'destructive',
      'email.domain_recheck': 'internal',
      'email.domain_set_receiving': 'internal',
      'email.domain_set_tracking': 'internal',
      'email.flow_create': 'internal',
      'email.flow_delete': 'destructive',
      'email.flow_set_status': 'external',
      'email.flow_update': 'internal',
      'email.label_create': 'internal',
      'email.label_delete': 'destructive',
      'email.layout_create': 'internal',
      'email.layout_delete': 'destructive',
      'email.layout_update': 'internal',
      'email.list_create': 'internal',
      'email.list_delete': 'destructive',
      'email.list_import': 'internal',
      'email.list_update': 'internal',
      'email.log_cancel': 'destructive',
      'email.mail_label': 'internal',
      'email.mail_mark_read': 'internal',
      'email.mail_move': 'internal',
      'email.mail_send': 'external',
      'email.mail_star': 'internal',
      'email.mailbox_alias_add': 'internal',
      'email.mailbox_alias_remove': 'destructive',
      'email.mailbox_assign': 'internal',
      'email.mailbox_create_mine': 'internal',
      'email.mailbox_create_shared': 'internal',
      'email.mailbox_set_disabled': 'internal',
      'email.send_mail': 'external',
      'email.send_template': 'external',
      'email.sender_add': 'internal',
      'email.sender_remove': 'destructive',
      'email.sender_set_default': 'internal',
      'email.setup_events': 'internal',
      'email.setup_receiving': 'internal',
      'email.suppression_add': 'internal',
      'email.suppression_remove': 'internal',
      'email.template_create': 'internal',
      'email.template_delete': 'destructive',
      'email.template_send_test': 'internal',
      'email.template_update': 'internal',
      'members.group_create': 'internal',
      'members.group_delete': 'destructive',
      'members.group_update': 'internal',
      'members.invite': 'external',
      'members.remove': 'destructive',
      'members.set_my_called': 'internal',
      'members.set_my_name': 'internal',
      'members.set_my_picture': 'internal',
      'members.set_open_join': 'public',
      'members.set_role': 'internal',
      'repo.merge': 'destructive',
      'website.app_deploy': 'public',
      'website.app_env_set': 'public',
      'website.github_connect_repo': 'internal',
      'website.github_disconnect_repo': 'destructive',
      'website.publish_page': 'public',
    })
  })
})

describe('module activation is the agent\'s own fix (owner, 2026-10-20)', () => {
  it('the orchestrator activates a module with no approval; deactivating waits for the owner', async () => {
    const { kernel, approvalStore } = makeInMemoryKernel()
    const { registerAdminTools } = await import('$lib/kernel/admin-bootstrap')
    await registerAdminTools(kernel)
    const agent: ToolContext = {
      principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] },
      requestId: 'req-activate',
    }
    await expect(
      kernel.registry.execute('kernel.module_activate', { module_id: 'website' }, agent),
    ).resolves.toMatchObject({ module_id: 'website', active: true })
    expect(await kernel.activations.get('website')).toBe(true)
    expect(await approvalStore.listPending()).toEqual([])

    await expect(
      kernel.registry.execute('kernel.module_deactivate', { module_id: 'website' }, agent),
    ).rejects.toMatchObject({ code: 'approval_required' })
  })
})

describe('moduleManifests', () => {
  it('declares the merged baseline modules (platform step 1: memory, email, website, brand, orchestrator)', () => {
    expect(moduleManifests.map((m) => m.id)).toEqual([
      'memory',
      'email',
      'website',
      'brand',
      'orchestrator',
      'members',
      'messages',
      'drive',
      'contribute',
      'calls',
      'contacts',
      'repos',
      'calendar',
      'contribute-hub',
      'assistant',
      'domains',
      'demo',
    ])
  })
})

describe('buildKernel (in-memory fakes, no DB)', () => {
  it('registers manifests and tools consistently', () => {
    const { kernel } = makeInMemoryKernel()

    expect(kernel.modules.list().map((m) => m.id)).toEqual([
      'memory',
      'email',
      'website',
      'brand',
      'orchestrator',
      'members',
      'messages',
      'drive',
      'contribute',
      'calls',
      'contacts',
      'repos',
      'calendar',
      'contribute-hub',
      'assistant',
      'domains',
      'demo',
    ])
    const toolNames = kernel.registry.list().map((t) => t.name)
    expect(toolNames).toContain('memory.retrieve_thoughts')
    expect(toolNames).toContain('email.send_mail')
    expect(toolNames).toContain('website.create_page')
    expect(toolNames.some((name) => name.startsWith('dev-agent.'))).toBe(false)
    expect(toolNames).toContain('brand.set_create')
    expect(toolNames).toContain('repo.worktree_create')
    expect(toolNames).toContain('repo.merge')
    expect(toolNames).toContain('roadmap.list_items')
    expect(toolNames).toContain('roadmap.add_item')
    expect(toolNames).toContain('roadmap.update_item')
    expect(toolNames).toContain('substrate.status')
    expect(toolNames).toContain('github.app_create')
    expect(toolNames).toContain('owlery.status')
    expect(toolNames).not.toContain('owlery.send_mail')
    expect(toolNames).toContain('members.list')
    expect(toolNames).toContain('members.invite')
    expect(toolNames).toContain('members.set_role')
    expect(toolNames).toContain('drive.list')
    expect(toolNames).toContain('drive.read')
    expect(toolNames).toContain('drive.write_text')
    expect(toolNames).toContain('drive.create_document')
    expect(toolNames).toContain('drive.archive')
    expect(toolNames).toContain('drive.unarchive')
    expect(toolNames).toContain('drive.list_archived')
    expect(toolNames).toContain('drive.suggest_archive')
    expect(toolNames).toContain('contribute.list')
    expect(toolNames).toContain('contribute.update')
    expect(toolNames).toContain('calls.list')
    expect(toolNames).toContain('calls.start')
    expect(toolNames).toContain('calls.end')
    expect(toolNames).toContain('contacts.list')
    expect(toolNames).toContain('contacts.follow_ups')
    expect(toolNames).toContain('contacts.pipeline')
    expect(toolNames).toContain('contacts.log_contact')
    expect(toolNames).toContain('calendar.list')
    expect(toolNames).toContain('calendar.free_busy')
    expect(toolNames.length).toBe(
      moduleManifests.reduce((sum, m) => sum + m.tools.length, 0),
    )
    // module = the owner of the name's namespace (prefix before the first ".")
    for (const tool of kernel.registry.list()) {
      const namespace = tool.name.slice(0, tool.name.indexOf('.'))
      expect(kernel.modules.ownerOfNamespace(namespace)?.id).toBe(tool.module)
    }
  })

  it('gates execution on module activation (fail closed)', async () => {
    const { kernel, activations } = makeInMemoryKernel()

    await expect(
      kernel.registry.execute('memory.retrieve_thoughts', { top_k: 1 }, ctx),
    ).rejects.toMatchObject({ code: 'module_inactive' })
    expect(kernel.registry.list().length).toBeGreaterThan(0)

    await activations.set('memory', true)
    await expect(
      kernel.registry.execute('memory.retrieve_thoughts', { top_k: 1 }, ctx),
    ).resolves.toEqual({ count: 0, results: [] })
  })

  it('wires StaticApprovalPolicy({email.send_mail, brand.set_activate, brand.visual_set_activate, website.publish_page, repo.merge}); the kernel gate stops external sends and brand go-lives at approval', async () => {
    // Orchestrator decision (2026-09-07): the approval gate fires for every
    // non-read tool, so the external send_mail halts as approval_required and
    // the handler never runs until an owner approves the pending request.
    // Phase-2c (G8/D5): brand.set_activate joins the set — activation is a
    // strategic brand decision owned by a human approver.
    // Phase-2d M5 (V9): brand.visual_set_activate gates the visual go-live —
    // once approved, the set applies globally to all user-facing surfaces.
    // Website founding journey: publishing is public, so the journey's
    // website.publish_page artifacts gate here too.
    // Phase-3 M2: repo.merge gates the agent's repo hands — landing agent work
    // on the instance repo is an owner decision made in chat.
    // Module lifecycle: deactivation gates (owner's yes); activation is the
    // agent's own fix for "module not active" (owner, 2026-10-20) — not gated.
    expect([...APPROVAL_REQUIRED_TOOLS].sort()).toEqual([
      'assistant.conversation_rename',
      'brand.set_activate',
      'brand.social_post_delete',
      'brand.visual_set_activate',
      'calendar.accept_proposal',
      'calendar.create_event',
      'calendar.delete_event',
      'calendar.dismiss_proposal',
      'calendar.set_default_visibility',
      'calendar.update_event',
      'calls.brain_set',
      'calls.brain_share_answer',
      'calls.invite_guests',
      'calls.remove_guest',
      'calls.schedule',
      'calls.start',
      'contacts.create',
      'contacts.delete',
      'contacts.import',
      'contacts.log_contact',
      'contacts.set_company_default_visibility',
      'contacts.set_my_default_visibility',
      'contacts.set_shared',
      'contacts.share_many',
      'contacts.update',
      'contribute.propose',
      'contribute.vote',
      'contribute_hub.revoke_install',
      'demo.seed_company',
      'drive.archive',
      'drive.create_document',
      'drive.create_folder',
      'drive.delete_forever',
      'drive.move',
      'drive.rename',
      'drive.restore',
      'drive.restore_revision',
      'drive.save_file_bytes',
      'drive.set_sharing',
      'drive.trash',
      'drive.unarchive',
      'drive.upload',
      'drive.write_text',
      'email.contact_add',
      'email.contact_remove',
      'email.domain_add',
      'email.domain_delete',
      'email.domain_recheck',
      'email.domain_set_receiving',
      'email.domain_set_tracking',
      'email.flow_create',
      'email.flow_delete',
      'email.flow_set_status',
      'email.flow_update',
      'email.label_create',
      'email.label_delete',
      'email.layout_create',
      'email.layout_delete',
      'email.layout_update',
      'email.list_create',
      'email.list_delete',
      'email.list_import',
      'email.list_update',
      'email.log_cancel',
      'email.mail_label',
      'email.mail_mark_read',
      'email.mail_move',
      'email.mail_send',
      'email.mail_star',
      'email.mailbox_alias_add',
      'email.mailbox_alias_remove',
      'email.mailbox_assign',
      'email.mailbox_create_mine',
      'email.mailbox_create_shared',
      'email.mailbox_set_disabled',
      'email.send_mail',
      'email.send_template',
      'email.sender_add',
      'email.sender_remove',
      'email.sender_set_default',
      'email.setup_events',
      'email.setup_receiving',
      'email.suppression_add',
      'email.suppression_remove',
      'email.template_create',
      'email.template_delete',
      'email.template_send_test',
      'email.template_update',
      'kernel.module_deactivate',
      'members.group_create',
      'members.group_delete',
      'members.group_update',
      'members.invite',
      'members.remove',
      'members.set_my_called',
      'members.set_my_name',
      'members.set_my_picture',
      'members.set_open_join',
      'members.set_role',
      'repo.merge',
      'website.app_deploy',
      'website.app_env_set',
      'website.github_connect_repo',
      'website.github_disconnect_repo',
      'website.publish_page',
    ])
    const { kernel, approvalStore } = makeInMemoryKernel()
    await kernel.activations.set('email', true)

    const input = { to: 'a@b.co', subject: 's', html: 'h', text: 't' }
    await expect(kernel.registry.execute('email.send_mail', input, ctx)).rejects.toMatchObject({
      code: 'approval_required',
    })
    const pending = await approvalStore.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ toolName: 'email.send_mail', status: 'pending' })
  })

  it('brand.visual_set_activate is approval-gated: no execution before the owner decision, activation after it (phase-2d M5/V9)', async () => {
    const { kernel, approvalStore } = makeInMemoryKernel()
    await kernel.activations.set('brand', true)

    // Draft a complete visual set through the M4 wizard tool; the gate under
    // test here is activation (M5).
    const draft = (await kernel.registry.execute(
      'brand.visual_set_create',
      {
        name: 'Kindred go-live',
        pickedIds: ['5a000000-0000-4000-8000-00000000000a'],
        cssVars: Object.fromEntries(
          REQUIRED_VISUAL_ROLES.map((role) => [
            `--${role}`,
            role === 'radius' ? '0.25rem' : '#111111',
          ]),
        ),
      },
      ctx,
    )) as { id: string }

    // First activation attempt halts at the approval gate; the store is untouched.
    await expect(
      kernel.registry.execute('brand.visual_set_activate', { setId: draft.id }, ctx),
    ).rejects.toMatchObject({ code: 'approval_required' })
    const pending = await approvalStore.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ toolName: 'brand.visual_set_activate', status: 'pending' })

    // A retry while still pending halts again (no second request, no execution).
    await expect(
      kernel.registry.execute('brand.visual_set_activate', { setId: draft.id }, ctx),
    ).rejects.toMatchObject({ code: 'approval_required' })
    expect(await approvalStore.listPending()).toHaveLength(1)

    // The owner approves; the SAME input now executes and activates.
    await approvalStore.decide(pending[0]!.id, 'approved', 'owner-1')
    const activated = (await kernel.registry.execute(
      'brand.visual_set_activate',
      { setId: draft.id },
      ctx,
    )) as { status: string }
    expect(activated.status).toBe('active')
  })

  it('runs owlery tools through the full pipeline (status reads the unset config)', async () => {
    const { kernel, activations } = makeInMemoryKernel()
    const { ensureSystemModulesActive } = await import('./index')
    await ensureSystemModulesActive(kernel)
    expect(await activations.get('email')).toBe(true)
    expect(await activations.get('website')).toBe(true)
    expect(kernel.registry.get('owlery.status')?.auditClass).toBe('read')
    expect(kernel.registry.get('owlery.send_mail')).toBeUndefined()
  })

  it('emits audit events through the injected sink', async () => {
    const { kernel, eventSink, activations } = makeInMemoryKernel()
    await activations.set('memory', true)
    await kernel.registry.execute('memory.retrieve_thoughts', { top_k: 1 }, ctx)
    expect(eventSink.events).toHaveLength(1)
    expect(eventSink.events[0]).toMatchObject({
      type: 'tool.executed',
      principalId: 'principal-1',
      payload: { tool: 'memory.retrieve_thoughts', ok: true },
    })
  })
})

describe('bootstrapKernel singleton', () => {
  it('returns the same instance on repeated calls', () => {
    const first = bootstrapKernel({ vcsCommitter: null })
    const second = bootstrapKernel()
    expect(second).toBe(first)
    expect(second.modules.get('email')).toBeDefined()
  })
})

describe('bootstrapChatGateway (composition root — gateway boot stage)', () => {
  const stubBrain: Brain = { personFor: async () => null, respond: async () => 'ok' }

  it('returns null while the module is inactive and needs no bot token', async () => {
    const { kernel } = makeInMemoryKernel()

    const boot = await bootstrapChatGateway(kernel, stubBrain, { env: {} })

    expect(boot).toBeNull()
    // Gateway surface is NOT registered while the module is inactive.
    expect(kernel.registry.get('chat-gateway.status')).toBeUndefined()
    expect(kernel.registry.get('chat-gateway.allowlist_add')).toBeUndefined()
    expect(kernel.modules.get('chat-gateway')).toBeUndefined()
  })

  it('registers the gateway manifest + tools through the kernel contract validation when active', async () => {
    const { kernel, activations } = makeInMemoryKernel()
    await activations.set('chat-gateway', true)

    const boot = await bootstrapChatGateway(kernel, stubBrain, {
      env: { TELEGRAM_BOT_TOKEN: 'test-token' },
      db: {} as AppDatabase,
    })

    expect(boot).not.toBeNull()
    expect(kernel.modules.get('chat-gateway')).toBeDefined()
    for (const name of [
      'chat-gateway.status',
      'chat-gateway.allowlist_add',
      'chat-gateway.allowlist_remove',
      'chat-gateway.allowlist_list',
    ]) {
      expect(kernel.registry.get(name)).toBeDefined()
    }
    expect(boot!.gateway).not.toBeNull()
    expect(boot!.allowlist).not.toBeNull()
    expect(boot!.sessions).not.toBeNull()
  })

  it('fails loud when the module is active but TELEGRAM_BOT_TOKEN is missing', async () => {
    const { kernel, activations } = makeInMemoryKernel()
    await activations.set('chat-gateway', true)

    await expect(
      bootstrapChatGateway(kernel, stubBrain, { env: {}, db: {} as AppDatabase }),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/)
  })

  it('composes the full Phase-0 path: brain → gateway stage → loop (fail-closed surface)', async () => {
    const { kernel, activations } = makeInMemoryKernel()
    await activations.set('chat-gateway', true)
    await activations.set('memory', true)

    const boot = await bootstrapOrchestrator(
      kernel,
      (brain) =>
        bootstrapChatGateway(kernel, brain, {
          env: { TELEGRAM_BOT_TOKEN: 'test-token' },
          db: {} as AppDatabase,
        }),
      {
        startLoop: false,
        engines: [['durable', { run: async (_s, input) => `durable:${input}` }]],
        people: { personById: async () => null },
      },
    )

    expect(boot.status()).toEqual({ chatGateway: 'active', loopRunning: false })
    expect(boot.brain).toBeInstanceOf(OrchestratorBrain)
    expect(boot.gateway).not.toBeNull()
    expect(boot.loop).not.toBeNull()

    // The brain offers memory tools (memory module active) and never gateway
    // owner tools — the gateway surface is owner-only by design (CB3: the owner
    // holds no kernel 'owner' role through the brain).
    const offered = await boot.brain.offeredTools({ id: 'owner-1', roles: ['admin', 'member'] })
    expect(offered.map((t) => t.name)).toContain('memory.retrieve_thoughts')
    expect(offered.map((t) => t.name)).not.toContain('chat-gateway.allowlist_add')

    await boot.loop!.stop()
  })
})

describe('Calls and Messages: who may be in a DM/channel call is the Messages answer', () => {
  it('a DM: its people; a stranger gets nothing (fail closed)', async () => {
    const m = messagesFixture()
    const port = callContextsFromMessages(async () => m.deps)
    const dm = await openDm(m.deps, 'bea', ['carl'])
    expect(await port.open('bea', 'dm', dm.id)).toEqual({ title: 'Bea Member, Carl Member', memberIds: ['bea', 'carl'] })
    expect(await port.open('owner', 'dm', dm.id)).toBeNull() // owners never see others' DMs
    expect(await port.isMember('carl', 'dm', dm.id)).toBe(true)
    expect(await port.isMember('owner', 'dm', dm.id)).toBe(false)
    expect(await port.open('bea', 'channel', dm.id)).toBeNull() // the kind must match
    expect(await port.open('bea', 'dm', 'not-a-uuid')).toBeNull()
  })

  it('a private channel: its readers; outsiders get nothing', async () => {
    const m = messagesFixture()
    const port = callContextsFromMessages(async () => m.deps)
    const ch = await createChannel(m.deps, 'owner', { name: 'leads', private: true, userIds: ['carl'] })
    const ctx = await port.open('carl', 'channel', ch.id)
    expect(ctx?.title).toBe('#leads')
    expect(ctx?.memberIds.sort()).toEqual(['carl', 'owner'])
    expect(await port.open('bea', 'channel', ch.id)).toBeNull()
    expect(await port.isMember('bea', 'channel', ch.id)).toBe(false)
  })

  it('a call that is over becomes one call line in its conversation (structured, once per call)', async () => {
    const m = messagesFixture()
    const log = callLogToMessages(async () => m.deps)
    const dm = await openDm(m.deps, 'bea', ['carl'])
    const ended = {
      callId: '22222222-2222-4222-8222-222222222222',
      contextKind: 'dm' as const,
      contextId: dm.id,
      startedBy: 'bea',
      outcome: 'ended' as const,
      durationSeconds: 245,
      endedAt: new Date(),
    }
    await log.callEnded(ended)
    await log.callEnded(ended)
    const page = await listMessages(m.deps, 'carl', dm.id)
    expect(page.messages.map((x) => [x.authorId, x.body, x.call])).toEqual([
      ['bea', '', { callId: ended.callId, outcome: 'ended', durationSeconds: 245 }],
    ])
  })

  it('calls.start by the agent halts at the approval gate (it rings people)', async () => {
    const { kernel, activations } = makeInMemoryKernel()
    await activations.set('calls', true)
    const agent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }, requestId: 'req-call' }
    await expect(
      kernel.registry.execute('calls.start', { context_kind: 'meeting', user_ids: ['bea'] }, agent),
    ).rejects.toMatchObject({ code: 'approval_required' })
  })
})
