import type {
  CreateDomainIdentityInput,
  IdentityInfo,
  SesApi,
  SesCredentials,
  SesEventType,
  SesFactory,
  SesSendInput,
} from './ses'
import type { SnsApi, SnsFactory } from './sns'

/** An AWS-shaped error (SDK exceptions carry `name` + `$metadata`). */
export function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name, $metadata: {} })
}

/** In-memory SES for tests: identities, sandbox flag, captured sends, injectable failures. */
export class FakeSes {
  identities = new Map<string, IdentityInfo>()
  created: string[] = []
  domains = new Map<string, CreateDomainIdentityInput>()
  deleted: string[] = []
  eventDestinations: { configurationSet: string; topicArn: string; events: SesEventType[] }[] = []
  unsuppressed: string[] = []
  sent: SesSendInput[] = []
  credentials: SesCredentials[] = []
  sandbox = false
  failAccount: Error | null = null
  failSend: Error | null = null
  failCreateDomain: Error | null = null

  verify(identity: string) {
    this.identities.set(identity, { exists: true, verified: true })
    return this
  }

  factory: SesFactory = (c) => {
    this.credentials.push(c)
    const api: SesApi = {
      getIdentity: async (id) => this.identities.get(id) ?? { exists: false, verified: false },
      createIdentity: async (id) => {
        this.created.push(id)
        this.identities.set(id, { exists: true, verified: false })
      },
      isSandbox: async () => {
        if (this.failAccount) throw this.failAccount
        return this.sandbox
      },
      send: async (input) => {
        if (this.failSend) throw this.failSend
        this.sent.push(input)
        return { messageId: `msg-${this.sent.length}` }
      },
      createDomainIdentity: async (input) => {
        if (this.failCreateDomain) throw this.failCreateDomain
        this.domains.set(input.domain, input)
        this.identities.set(input.domain, { exists: true, verified: false })
      },
      getDomainIdentity: async (domain) => {
        const id = this.identities.get(domain)
        if (!id) return { exists: false, verification: 'NOT_STARTED', dkim: 'NOT_STARTED', mailFrom: 'NOT_STARTED', errorType: null }
        const s = id.verified ? 'SUCCESS' : 'PENDING'
        return { exists: true, verification: s, dkim: s, mailFrom: s, errorType: null }
      },
      deleteIdentity: async (identity) => {
        this.deleted.push(identity)
        this.identities.delete(identity)
        this.domains.delete(identity)
      },
      ensureEventDestination: async (input) => {
        this.eventDestinations.push(input)
      },
      removeFromAccountSuppression: async (email) => {
        this.unsuppressed.push(email)
      },
    }
    return api
  }
}

/** In-memory SNS for tests: topics and HTTPS subscriptions. */
export class FakeSns {
  topics: string[] = []
  subscriptions: { topicArn: string; endpoint: string }[] = []
  failSubscribe: Error | null = null
  /** Real SNS leaves a new subscription pending until the endpoint confirms it. */
  confirmImmediately = false

  factory: SnsFactory = (c) => {
    const api: SnsApi = {
      createTopic: async (name) => {
        const arn = `arn:aws:sns:${c.region}:000000000000:${name}`
        if (!this.topics.includes(arn)) this.topics.push(arn)
        return arn
      },
      subscribeHttps: async (topicArn, endpoint) => {
        if (this.failSubscribe) throw this.failSubscribe
        this.subscriptions.push({ topicArn, endpoint })
        return { confirmed: this.confirmImmediately }
      },
    }
    return api
  }
}
