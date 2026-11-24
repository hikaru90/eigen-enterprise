import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { CORE_EVENTS } from '$lib/kernel/event-catalog'
import { InMemoryEventSink } from '$lib/kernel/events'
import { CHAT_GATEWAY_MODULE_ID } from '$lib/kernel/gateway'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { InMemoryJourneyStore } from '$lib/kernel/playbook'
import type { PrincipalStore } from '$lib/kernel/principals'
import { CORE_UI_SLOTS } from '$lib/kernel/ui-slots'
import type { WiredKernel } from '$lib/kernel/wiring'
import { bootApp } from '$lib/server/boot'
import type { AppDatabase } from '$lib/server/db/context'
import {
  APPROVAL_REQUIRED_TOOLS,
  bootstrapChatGateway,
  bootstrapRecap,
  buildKernel,
} from '../modules/index'
import { RECAP_MODULE_ID } from '../modules/recap/types'
import { CORE_API_VERSION } from './core-api-version'
import { snapshotContract, type CoreApiLock } from './lock'

/**
 * A database that is never there: composing the contract must not touch one.
 * Any use fails loud, naming what reached for it.
 */
const NO_DATABASE = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `core-api snapshot: no database here (something reached for db.${String(property)})`,
      )
    },
  },
) as AppDatabase

/**
 * The chat gateway's bot token is required to construct the stage; the
 * snapshot only registers its tools and never starts the poll loop, so this
 * value is never sent anywhere.
 */
const SNAPSHOT_GATEWAY_ENV = { TELEGRAM_BOT_TOKEN: 'core-api-snapshot-never-sent' }

/**
 * The production composition (boot.ts → buildKernel → admin tools →
 * orchestrator → chat gateway → recap), with the kernel's storage in memory —
 * the same seam boot.wiring.spec.ts uses — so no database or network is
 * needed. Every module is part of the contract, so the activation-gated
 * stages (chat gateway, recap) register their tools here too; they return no
 * running stage, so no poll loop or tick starts.
 */
export async function composeContractKernel(): Promise<WiredKernel> {
  const activations = new InMemoryActivationStore()
  await activations.set(CHAT_GATEWAY_MODULE_ID, true)
  await activations.set(RECAP_MODULE_ID, true)
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
    bootstrapChatGateway: async (kernel, brain) => {
      await bootstrapChatGateway(kernel, brain, { env: SNAPSHOT_GATEWAY_ENV, db: NO_DATABASE })
      return null
    },
    bootstrapRecap: async (kernel) => {
      await bootstrapRecap(kernel, { env: SNAPSHOT_GATEWAY_ENV, db: NO_DATABASE })
      return null
    },
  })
  return boot.kernel
}

/** The working tree's contract: the composed registry, the event catalog and the UI slots. */
export async function currentContract(): Promise<CoreApiLock> {
  const kernel = await composeContractKernel()
  return snapshotContract({
    coreApi: CORE_API_VERSION,
    tools: kernel.registry.list(),
    gated: APPROVAL_REQUIRED_TOOLS,
    events: CORE_EVENTS,
    uiSlots: CORE_UI_SLOTS,
  })
}
