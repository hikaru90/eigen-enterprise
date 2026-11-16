import { moduleSource } from '$lib/kernel/cloudevents'
import { emitKernelEvent } from '$lib/kernel/events'
import { appKernel } from '$lib/server/boot'
import { AudienceError } from '../../../../modules/email/platform/flows/service'
import { emailPlatform } from '../../../../modules/email/platform/service'
import { createMemoryRateLimiter } from './api-send'
import { dbMailSendStore } from './api-send-store'
import { SubscribeRefused, type MailSubscribeDeps } from './api-subscribe'

/** 300 sign-ups per key per hour (in-memory); the app limits each visitor itself. */
const limiter = createMemoryRateLimiter({ limit: 300, windowMs: 60 * 60_000 })

export function mailSubscribeDeps(principalId: string): MailSubscribeDeps {
  const store = dbMailSendStore()
  return {
    canSendMail: (keyId) => store.canSendMail(keyId),
    async publicList(listId) {
      const list = await emailPlatform()
        .audience.getList(listId)
        .catch((err: unknown) => {
          if (err instanceof AudienceError) return null
          throw err
        })
      return list?.publicSignup ? { id: list.id } : null
    },
    async addContact(listId, input) {
      try {
        const { contact, created } = await emailPlatform().audience.addContact(listId, input)
        return { status: contact.status, created }
      } catch (err) {
        if (err instanceof AudienceError) throw new SubscribeRefused(err.message)
        throw err
      }
    },
    limiter,
    // Shown in Overview recent activity, like api_send.
    async audit(entry) {
      const kernel = await appKernel()
      await emitKernelEvent(kernel.eventSink, {
        type: 'tool.executed',
        principalId,
        source: moduleSource('email'),
        payload: { tool: 'email.api_subscribe', auditClass: 'write', ...entry },
      })
    },
  }
}
