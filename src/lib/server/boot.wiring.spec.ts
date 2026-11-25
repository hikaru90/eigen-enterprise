import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import type { EngineContext } from '$lib/kernel/engine'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { InMemoryJourneyStore } from '$lib/kernel/playbook'
import type { PersonRef, PrincipalStore } from '$lib/kernel/principals'
import { buildKernel } from '../../../modules/index'
import { ORCHESTRATOR_AGENT_ID } from '../../../modules/orchestrator/brain'
import { bootApp } from './boot'

/**
 * The REAL production composition (boot.ts → buildKernel → bootstrapOrchestrator
 * → gateway/recap stages) — no stage is mocked. Only the kernel's storage is
 * in-memory (buildKernel's own injection seam), so no DB is needed. Pins the
 * production incident "unknown tool: kernel.module_activate": the web
 * server's kernel never registered the admin tools (only the CLI did).
 */
describe('bootApp — production wiring', () => {
  it('the web kernel carries the admin tools and offers them to the orchestrator', async () => {
    const activations = new InMemoryActivationStore()
    const boot = await bootApp({
      env: {},
      buildKernel: () =>
        buildKernel({
          activations,
          eventSink: new InMemoryEventSink(),
          approvalStore: new InMemoryApprovalStore(),
          principals: {} as PrincipalStore,
          vcsCommitter: null,
        }),
      journeys: new InMemoryJourneyStore(),
      recap: { startTick: false },
      coworkers: { start: false },
    })

    expect(boot.kernel.registry.get('kernel.module_activate')).toBeDefined()
    expect(boot.kernel.registry.get('kernel.module_list')).toBeDefined()

    // The brain acting for an admin (CB3: the person's rights) is offered the admin tools.
    const offered = (
      await boot.orchestrator.runtime.listAgentTools(ORCHESTRATOR_AGENT_ID, { id: 'admin-1', roles: ['admin', 'member'] })
    ).map((tool) => tool.name)
    expect(offered).toContain('kernel.module_activate')
    expect(offered).toContain('kernel.module_list')
    // Website (hosting + GitHub) and Email (Owlery) are on from the first boot
    // (not only once a settings page opens).
    for (const id of ['website', 'email']) expect(await activations.get(id)).toBe(true)
  })

  /**
   * CB3, the announced change (plan/progress.md): through the brain a member
   * reaches exactly the member tools — their own Memory and tasks, Drive,
   * calendar, contacts, messages, calls, Contribute, the groups and whoami.
   * Every other tool the old admin agent identity reached is now the admins'
   * only (MEMBER_LOSES_VIA_BRAIN pins the list). Admins keep everything.
   */
  it('a member reaches only member tools through the brain; the admin reach they had is gone', async () => {
    const activations = new InMemoryActivationStore()
    const boot = await bootApp({
      env: {},
      buildKernel: () =>
        buildKernel({
          activations,
          eventSink: new InMemoryEventSink(),
          approvalStore: new InMemoryApprovalStore(),
          principals: {} as PrincipalStore,
          vcsCommitter: null,
        }),
      journeys: new InMemoryJourneyStore(),
      recap: { startTick: false },
      coworkers: { start: false },
    })
    // bootApp is memoized per process: switch on every module of THE boot's kernel.
    for (const t of boot.kernel.registry.list()) await boot.kernel.activations.set(t.module, true)
    const surface = async (roles: string[]) =>
      (await boot.orchestrator.runtime.listAgentTools(ORCHESTRATOR_AGENT_ID, { id: 'p', roles })).map((t) => t.name).sort()
    const member = await surface(['member'])
    const admin = await surface(['admin', 'member'])
    // What the old orchestrator identity (roles admin + agent) was offered, for everyone.
    const before = (
      await Promise.all(
        boot.kernel.registry
          .list()
          .filter((t) => t.permission.roles.some((r) => r === 'admin' || r === 'agent'))
          .map(async (t) => ((await boot.kernel.modules.isToolActive(t.name)) ? t.name : null)),
      )
    )
      .filter((n): n is string => n !== null)
      .sort()

    expect(member).toEqual([...MEMBER_KEEPS_VIA_BRAIN].sort())
    expect(before.filter((n) => !member.includes(n))).toEqual([...MEMBER_LOSES_VIA_BRAIN].sort())
    // Admins lose nothing.
    expect(before.filter((n) => !admin.includes(n))).toEqual([])
    // Offered is not allowed: an owner/admin tool still refuses a member when it runs.
    await expect(
      boot.kernel.registry.execute('repos.set_copy_mode', { repoId: 1, mode: 'docs' }, { principal: { id: 'member-1', kind: 'human', roles: ['member'] }, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })
})

/**
 * plan/shared-memory-voice-agent-tools.md §3 — the brain reaches every
 * registry tool the asking person may run through the ee CLI tool: for each
 * brain role set, `ee tool list` is exactly the tools those roles may run (all
 * modules on), each has its input schema under `ee tool help`, and a member's
 * `ee tool run` of an admin tool is refused by the registry. Nobody reaches
 * the owner-only and service-only tools through the brain (CB3 decision: the
 * kernel owner role stays off the brain — those stay a person's own clicks).
 */
describe('bootApp — the brain reaches every tool of the person through ee', () => {
  it('per role: ee lists, explains and runs exactly the tools that role may run; admin-only refused for a member', async () => {
    const boot = await bootApp({
      env: {},
      buildKernel: () =>
        buildKernel({
          activations: new InMemoryActivationStore(),
          eventSink: new InMemoryEventSink(),
          approvalStore: new InMemoryApprovalStore(),
          principals: {} as PrincipalStore,
          vcsCommitter: null,
        }),
      journeys: new InMemoryJourneyStore(),
      recap: { startTick: false },
      coworkers: { start: false },
    })
    for (const t of boot.kernel.registry.list()) await boot.kernel.activations.set(t.module, true)
    const runtime = boot.orchestrator.runtime
    // A scripted probe agent on the SAME runtime (the brain's surface + meta tools), no model.
    let script: (ctx: EngineContext) => Promise<unknown> = async () => undefined
    let result: unknown
    if (!runtime.getAgent('ee-probe')) {
      runtime.registerEngine('ee-probe', {
        run: async (_s, _i, ctx) => {
          result = await script(ctx)
          return 'ok'
        },
      })
      runtime.registerAgent({
        id: 'ee-probe',
        personaName: 'probe',
        description: 'boot.wiring ee probe',
        loopEngine: 'ee-probe',
        toolScope: 'all',
        memoryScope: 'company',
        verificationPolicy: 'none',
        instructions: 'engine-default',
        actsAs: 'person',
        enabled: true,
      })
    }
    const asPerson = async (person: PersonRef, run: (ctx: EngineContext) => Promise<unknown>) => {
      script = run
      await runtime.dispatch('ee-probe', 's', 'probe', undefined, { person })
      return result
    }

    const all = boot.kernel.registry.list()
    const mayRun = (roles: string[]) =>
      all.filter((t) => t.permission.roles.some((r) => roles.includes(r))).map((t) => t.name).sort()
    const member: PersonRef = { id: 'member-1', roles: ['member'] }
    const admin: PersonRef = { id: 'admin-1', roles: ['admin', 'member'] }

    for (const person of [member, admin]) {
      const expected = mayRun(person.roles)
      const { listed, direct, helps } = (await asPerson(person, async (ctx) => {
        const listed = ((await ctx.executeTool('ee', { args: ['tool', 'list'] })) as Array<{ name: string }>).map((t) => t.name).sort()
        const helps: Array<{ name: string; inputSchema: unknown }> = []
        for (const name of listed) helps.push((await ctx.executeTool('ee', { args: ['tool', 'help', name] })) as never)
        return { listed, direct: ctx.listTools().map((t) => t.name), helps }
      })) as { listed: string[]; direct: string[]; helps: Array<{ name: string; inputSchema: { type?: unknown } }> }
      expect(listed).toEqual(expected)
      // The direct surface is unchanged (every tool still offered as itself) plus ee.
      expect(direct.filter((n) => n !== 'ee').sort()).toEqual(expected)
      expect(direct).toContain('ee')
      expect(helps.map((h) => h.name)).toEqual(expected)
      for (const h of helps) expect(h.inputSchema).toMatchObject({ type: 'object' })
    }

    // Admin-only tools: refused for a member, through ee, by the registry — help and run alike.
    const adminOnly = mayRun(admin.roles).filter((n) => !mayRun(member.roles).includes(n))
    expect(adminOnly.length).toBeGreaterThan(100)
    const refusals = (await asPerson(member, async (ctx) => {
      const codes: Record<string, string[]> = {}
      for (const name of adminOnly) {
        for (const args of [['tool', 'help', name], ['tool', 'run', name]]) {
          try {
            await ctx.executeTool('ee', { args, input: args[1] === 'run' ? {} : undefined })
            ;(codes.ran ??= []).push(name)
          } catch (err) {
            const code = (err as { code?: string }).code ?? 'thrown'
            ;(codes[code] ??= []).push(name)
          }
        }
      }
      return codes
    })) as Record<string, string[]>
    expect(Object.keys(refusals)).toEqual(['permission_denied'])
    expect(refusals.permission_denied).toHaveLength(adminOnly.length * 2)

    // No brain role set reaches the owner-only and service-only tools.
    const nobody = all
      .filter((t) => !t.permission.roles.some((r) => admin.roles.includes(r)))
      .map((t) => t.name)
      .sort()
    expect(nobody).toEqual([...NO_BRAIN_REACH].sort())
    const ownerOnly = (await asPerson(admin, async (ctx) => {
      const codes: string[] = []
      for (const name of nobody) {
        try {
          await ctx.executeTool('ee', { args: ['tool', 'run', name], input: {} })
          codes.push('ran')
        } catch (err) {
          codes.push((err as { code?: string }).code ?? 'thrown')
        }
      }
      return codes
    })) as string[]
    expect(new Set(ownerOnly)).toEqual(new Set(['permission_denied']))
  })
})

/**
 * Registry tools no person reaches through the brain: the kernel owner role
 * stays off the brain (CB3) and service tools are webhooks' own. Not new — the
 * same before ee; pinned so a new one is a visible decision.
 */
const NO_BRAIN_REACH = ['agent.disable', 'agent.enable', 'brand.picker_choose', 'github.auto_deploy', 'website.app_auto_deploy'] as const

/** What a member (no admin role) reaches through the brain — as themselves, under their own access checks. */
const MEMBER_KEEPS_VIA_BRAIN = [
  // C7: which events a co-worker notices, and what became of them (counts only).
  'coworkers.event_subscriptions_get',
  'coworkers.get',
  'coworkers.list',
  'coworkers.needs_you',
  'coworkers.notice_seen',
  'coworkers.rhythm_list',
  'coworkers.runs',
  'coworkers.templates',
  // CB2: the decision kinds and the rows about them; their own Needs you questions and answers.
  'decisions.answer',
  'decisions.kinds',
  'decisions.log',
  'decisions.questions',
  'org.chart',
  'org.set_position',
  'assistant.conversation_rename',
  'brand.material_export',
  'brand.material_text_suggest',
  'brand.social_caption_suggest',
  'brand.social_post_create',
  'brand.social_post_delete',
  'brand.social_post_get',
  'brand.social_post_list',
  'brand.social_post_update',
  'brand.social_post_upload',
  'calendar.accept_proposal',
  'calendar.add_call',
  'calendar.create_event',
  'calendar.delete_event',
  'calendar.dismiss_proposal',
  'calendar.free_busy',
  'calendar.list',
  'calendar.proposals',
  'calendar.remove_call',
  'calendar.set_default_visibility',
  'calendar.set_reminder',
  'calendar.settings_get',
  'calendar.update_event',
  'calls.brain_recap',
  'calls.brain_set',
  'calls.brain_share_answer',
  'calls.chat_post',
  'calls.chat_read',
  'calls.end',
  'calls.invite_guests',
  'calls.list',
  'calls.remove_guest',
  'calls.schedule',
  'calls.start',
  'contacts.create',
  'contacts.delete',
  'contacts.follow_ups',
  'contacts.get',
  'contacts.import',
  'contacts.list',
  'contacts.log_contact',
  'contacts.pipeline',
  'contacts.set_company_default_visibility',
  'contacts.set_my_default_visibility',
  'contacts.set_shared',
  'contacts.share_many',
  'contacts.update',
  'contribute.get',
  'contribute.list',
  'contribute.propose',
  'contribute.update',
  'contribute.vote',
  'drive.app_status',
  'drive.archive',
  'drive.create_document',
  'drive.create_folder',
  'drive.delete_forever',
  'drive.delete_forever_many',
  'drive.get_sharing',
  'drive.list',
  'drive.list_archived',
  'drive.list_revisions',
  'drive.list_trash',
  'drive.make_xlsx_copy',
  'drive.move',
  'drive.move_many',
  'drive.pdf_add_note',
  'drive.pdf_delete_pages',
  'drive.pdf_edit_annotations',
  'drive.pdf_extract_pages',
  'drive.pdf_fill_form',
  'drive.pdf_list_annotations',
  'drive.pdf_list_form_fields',
  'drive.pdf_merge',
  'drive.pdf_reorder',
  'drive.pdf_reply',
  'drive.pdf_rotate',
  'drive.pdf_set_properties',
  'drive.pdf_split',
  'drive.read',
  'drive.rename',
  'drive.restore',
  'drive.restore_many',
  'drive.restore_revision',
  'drive.save_file_bytes',
  'drive.set_sharing',
  'drive.share_many',
  'drive.shared_with_me',
  'drive.sheet_chart_create',
  'drive.sheet_chart_delete',
  'drive.sheet_chart_list',
  'drive.sheet_chart_update',
  'drive.sheet_comment_add',
  'drive.sheet_comment_delete',
  'drive.sheet_comment_edit',
  'drive.sheet_comment_list',
  'drive.sheet_comment_reply',
  'drive.sheet_comment_resolve',
  'drive.sheet_filter',
  'drive.sheet_format',
  'drive.sheet_freeze',
  'drive.sheet_picture_delete',
  'drive.sheet_picture_insert',
  'drive.sheet_picture_update',
  'drive.sheet_read',
  'drive.sheet_shape_create',
  'drive.sheet_shape_delete',
  'drive.sheet_shape_update',
  'drive.sheet_sort',
  'drive.sheet_structure',
  'drive.sheet_write',
  'drive.suggest_archive',
  'drive.trash',
  'drive.trash_many',
  'drive.unarchive',
  'drive.upload',
  'drive.write_text',
  'ee',
  'email.label_create',
  'email.label_delete',
  'email.mail_label',
  'email.mail_list',
  'email.mail_mark_read',
  'email.mail_move',
  'email.mail_read',
  'email.mail_send',
  'email.mail_star',
  'email.mailbox_list',
  // Handover pages (plan/handover.md): every member reads them, the owner writes.
  'handover.add_entry',
  'handover.assign_entry',
  'handover.create',
  'handover.draft_entry',
  'handover.get',
  'handover.list',
  'handover.remove_entry',
  'handover.update_entry',
  'kernel.whoami',
  'members.group_list',
  'members.set_my_called',
  'members.set_my_name',
  'members.set_my_picture',
  'memory.answer_check_in',
  'memory.apply_project_review',
  'memory.assign_thought_project',
  'memory.assign_thought_to_agent',
  'memory.bind_agent_project',
  'memory.capture_thought',
  'memory.clean_up_graph',
  'memory.complete_task',
  'memory.create_project',
  'memory.create_task',
  'memory.create_text_file',
  'memory.delete_archived_thoughts',
  'memory.delete_entity',
  'memory.delete_task',
  'memory.delete_text_file',
  'memory.delete_thought',
  'memory.dismiss_project',
  'memory.edit_thought',
  'memory.get_entity',
  'memory.get_project_timeline',
  'memory.get_text_file',
  'memory.get_thought',
  'memory.intake',
  'memory.link_text_file',
  'memory.list_agent_projects',
  'memory.list_archived_thoughts',
  'memory.list_connected_agents',
  'memory.list_projects',
  'memory.list_scheduled_tasks',
  'memory.list_tasks',
  'memory.list_text_files',
  'memory.list_thought_notes',
  'memory.list_thoughts',
  'memory.order_project_task',
  'memory.pause_scheduled_task',
  'memory.relink_thought',
  'memory.rename_project',
  'memory.reschedule_timeline_item',
  'memory.resume_scheduled_task',
  'memory.retrieve_thoughts',
  'memory.retry_enrichment',
  'memory.retry_scheduled_task_step',
  'memory.run_scheduled_task',
  'memory.search_text_files',
  'memory.set_project_deadline',
  'memory.set_project_milestone',
  'memory.set_project_visibility',
  'memory.set_text_file_visibility',
  'memory.set_thought_status',
  'memory.set_timeline_item_status',
  'memory.snooze_timeline_item',
  'memory.stop_scheduled_task',
  'memory.sync_entity',
  'memory.unbind_agent_project',
  'memory.unlink_text_file',
  'memory.update_entity',
  'memory.update_task',
  'memory.update_text_file',
  'messages.create_channel',
  'messages.delete',
  'messages.edit',
  'messages.list_channels',
  'messages.mark_read',
  'messages.members',
  'messages.open_dm',
  'messages.post',
  'messages.react',
  'messages.read',
  'messages.set_do_not_disturb',
  'messages.thread',
  'messages.upload_attachments',
  // U2: the company's own modules — what they are, where they stand, their code (read).
  'modules.get',
  'modules.list',
  'modules.source',
  'notifications.devices',
  'notifications.settings_get',
  'notifications.settings_set',
  'notifications.test',
  'questions.answer',
  'questions.ask',
  'questions.close',
  'questions.get',
  'questions.list',
  'questions.tags',
  'reminders.complete',
  'reminders.create',
  'reminders.delete',
  'reminders.list',
  'reminders.pause',
  'reminders.resume',
  'reminders.snooze',
  'reminders.update',
  'settings.my_ai_usage',
  'tasks.assign',
  'tasks.assignees',
  'tasks.comment',
  'tasks.complete',
  'tasks.list',
  'tasks.mark_seen',
] as const

/**
 * CB3 announced change: the tools a non-admin member reached through the brain
 * (the old admin agent identity) and no longer does — the admins' tools. Not
 * in this composition, lost the same way: recap.run_now and chat-gateway.status
 * (owner/admin, when those modules are on).
 */
const MEMBER_LOSES_VIA_BRAIN = [
  'coworkers.avatar_upload',
  'coworkers.create',
  'coworkers.disable',
  'coworkers.enable',
  // C7: an admin switches a co-worker's event kinds on and off, and labels its shadow decisions.
  'coworkers.event_subscriptions_set',
  'decisions.label',
  'coworkers.remove',
  'coworkers.rhythm_create',
  'coworkers.rhythm_delete',
  'coworkers.rhythm_run_now',
  'coworkers.rhythm_update',
  'coworkers.update',
  'agent.list',
  'brand.corpus_get',
  'brand.corpus_list',
  'brand.corpus_similar',
  'brand.criterion_add',
  'brand.example_add',
  'brand.extract_accept',
  'brand.extract_guide_start',
  'brand.extract_judge',
  'brand.extract_propose',
  'brand.extract_session_get',
  'brand.extract_start',
  'brand.glossary_add',
  'brand.lexicon_add',
  'brand.selection_matches',
  'brand.set_activate',
  'brand.set_create',
  'brand.set_get',
  'brand.set_list',
  'brand.set_update',
  'brand.token_add',
  'brand.visual_set_activate',
  'brand.visual_set_create',
  'brand.visual_set_get',
  'brand.visual_set_list',
  'brand.visual_set_update',
  'contribute_hub.get',
  'contribute_hub.list',
  'contribute_hub.revoke_install',
  'demo.guest_access_get',
  'demo.guest_access_set',
  // U2 §7: the module hub's reads and summarise are the hub box's admins' (and agent's).
  'module_hub.file',
  'module_hub.get',
  'module_hub.list',
  'module_hub.summarize',
  'module_hub.tree',
  'module_hub.version',
  'demo.seed_company',
  'demo.status',
  'domains.list',
  'domains.recheck',
  'domains.remove',
  'domains.retry_certificate',
  'domains.set_target',
  'drive.app_run',
  'drive.app_stop',
  'email.contact_add',
  'email.contact_lists',
  'email.contact_remove',
  'email.domain_add',
  'email.domain_delete',
  'email.domain_list',
  'email.domain_recheck',
  'email.domain_set_receiving',
  'email.domain_set_tracking',
  'email.flow_create',
  'email.flow_delete',
  'email.flow_list',
  'email.flow_set_status',
  'email.flow_update',
  'email.layout_create',
  'email.layout_delete',
  'email.layout_update',
  'email.list_contacts',
  'email.list_create',
  'email.list_delete',
  'email.list_import',
  'email.list_update',
  'email.log_cancel',
  'email.log_get',
  'email.log_list',
  'email.mailbox_admin',
  'email.mailbox_alias_add',
  'email.mailbox_alias_remove',
  'email.mailbox_assign',
  'email.mailbox_create_mine',
  'email.mailbox_create_shared',
  'email.mailbox_set_disabled',
  'email.send_mail',
  'email.send_template',
  'email.sender_add',
  'email.sender_list',
  'email.sender_remove',
  'email.sender_set_default',
  'email.setup_events',
  'email.setup_receiving',
  'email.suppression_add',
  'email.suppression_list',
  'email.suppression_remove',
  'email.template_create',
  'email.template_delete',
  'email.template_get',
  'email.template_list',
  'email.template_send_test',
  'email.template_update',
  'github.app_create',
  'github.app_deploy',
  'github.repos_list',
  'github.status',
  'kernel.approvals_decide',
  'kernel.approvals_list',
  'kernel.backup_run',
  'kernel.export_company',
  'kernel.export_delete',
  'kernel.export_list',
  'kernel.export_status',
  'kernel.module_activate',
  'kernel.module_deactivate',
  'kernel.module_list',
  'kernel.release_install',
  'kernel.release_rollback',
  'kernel.release_status',
  'members.group_create',
  'members.group_delete',
  'members.group_update',
  'members.get_open_join',
  'members.invite',
  'members.list',
  'members.remove',
  'members.set_open_join',
  'members.set_role',
  // U2: building, running and removing the company's own modules is the admins' (and the agent's for them).
  'modules.accept_sharing',
  'modules.commit',
  'modules.delete_file',
  'modules.deploy',
  'modules.logs',
  'modules.publish',
  'modules.remove',
  'modules.scaffold',
  'modules.status',
  'modules.test',
  'modules.write_file',
  'owlery.status',
  'repo.merge',
  'repo.read_file',
  'repo.run',
  'repo.worktree_create',
  'repo.write_file',
  'repos.available',
  'repos.list',
  'repos.set_copy_mode',
  'repos.set_repo',
  'repos.sync_now',
  'roadmap.add_item',
  'roadmap.list_items',
  'roadmap.update_item',
  'settings.get',
  'settings.logo_recrop',
  'settings.logo_remove',
  'settings.logo_set',
  'settings.member_ai_cap_get',
  'settings.member_ai_cap_set',
  'settings.update',
  'substrate.app_remove',
  'substrate.backup_status',
  'substrate.domain_add',
  'substrate.domain_remove',
  'substrate.secret_set',
  'substrate.status',
  'website.activity',
  'website.app_deploy',
  'website.app_deploy_status',
  'website.app_diagnose',
  'website.app_domain_remove',
  'website.app_domain_set',
  'website.app_env_set',
  'website.app_get',
  'website.app_list',
  'website.app_logs',
  'website.app_mail_disable',
  'website.app_mail_enable',
  'website.app_remove',
  'website.app_suggest_contract',
  'website.create_page',
  'website.delete_page',
  'website.found_company',
  'website.get_page',
  'website.github_available_repos',
  'website.github_connect_repo',
  'website.github_deploy_key_check',
  'website.github_deploy_key_create',
  'website.github_deploy_key_delete',
  'website.github_disconnect_repo',
  'website.github_inspect_repo',
  'website.github_list_repos',
  'website.list_pages',
  'website.publish_page',
  'website.site_info',
  'website.update_page',
] as const
