import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { InMemoryJourneyStore } from '$lib/kernel/playbook'
import type { PrincipalStore } from '$lib/kernel/principals'
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

/** What a member (no admin role) reaches through the brain — as themselves, under their own access checks. */
const MEMBER_KEEPS_VIA_BRAIN = [
  'brand.social_caption_suggest',
  'brand.social_post_create',
  'brand.social_post_get',
  'brand.social_post_list',
  'brand.social_post_update',
  'calendar.free_busy',
  'calendar.list',
  'calls.end',
  'calls.list',
  'calls.start',
  'contacts.create',
  'contacts.follow_ups',
  'contacts.get',
  'contacts.list',
  'contacts.log_contact',
  'contacts.pipeline',
  'contacts.update',
  'contribute.get',
  'contribute.list',
  'contribute.update',
  'drive.app_status',
  'drive.archive',
  'drive.create_document',
  'drive.list',
  'drive.list_archived',
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
  'drive.shared_with_me',
  'drive.suggest_archive',
  'drive.unarchive',
  'drive.write_text',
  'kernel.whoami',
  'members.group_list',
  'memory.capture_thought',
  // Contribute e9490497: the person's own Memory › Tasks through the assistant.
  'memory.complete_task',
  'memory.create_task',
  'memory.create_text_file',
  'memory.delete_task',
  'memory.get_project_timeline',
  'memory.get_text_file',
  'memory.list_projects',
  'memory.list_tasks',
  'memory.list_text_files',
  'memory.retrieve_thoughts',
  'memory.search_text_files',
  'memory.set_project_visibility',
  'memory.set_text_file_visibility',
  'memory.update_task',
  'memory.update_text_file',
  'messages.list_channels',
  'messages.read',
  'notifications.devices',
  'notifications.test',
  'reminders.complete',
  'reminders.create',
  'reminders.delete',
  'reminders.list',
  'reminders.pause',
  'reminders.resume',
  'reminders.snooze',
  'reminders.update',
  'tasks.assign',
  'tasks.assignees',
  'tasks.comment',
  'tasks.complete',
  'tasks.list',
] as const

/**
 * CB3 announced change: the tools a non-admin member reached through the brain
 * (the old admin agent identity) and no longer does — the admins' tools. Not
 * in this composition, lost the same way: recap.run_now and chat-gateway.status
 * (owner/admin, when those modules are on).
 */
const MEMBER_LOSES_VIA_BRAIN = [
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
  'drive.app_run',
  'drive.app_stop',
  'email.contact_add',
  'email.contact_lists',
  'email.domain_add',
  'email.domain_list',
  'email.domain_recheck',
  'email.flow_list',
  'email.log_get',
  'email.log_list',
  'email.send_mail',
  'email.send_template',
  'email.sender_add',
  'email.sender_list',
  'email.suppression_add',
  'email.suppression_list',
  'email.suppression_remove',
  'email.template_get',
  'email.template_list',
  'github.app_create',
  'github.app_deploy',
  'github.repos_list',
  'github.status',
  'kernel.approvals_decide',
  'kernel.approvals_list',
  'kernel.module_activate',
  'kernel.module_deactivate',
  'kernel.module_list',
  'members.group_create',
  'members.group_delete',
  'members.group_update',
  'members.invite',
  'members.list',
  'members.set_role',
  'owlery.status',
  'repo.merge',
  'repo.read_file',
  'repo.run',
  'repo.worktree_create',
  'repo.write_file',
  'repos.list',
  'repos.set_copy_mode',
  'repos.sync_now',
  'roadmap.add_item',
  'roadmap.list_items',
  'roadmap.update_item',
  'settings.get',
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
