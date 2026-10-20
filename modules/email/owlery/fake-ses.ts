import type { IdentityInfo, SesApi, SesCredentials, SesFactory, SesSendInput } from './ses'

/** An AWS-shaped error (SDK exceptions carry `name` + `$metadata`). */
export function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name, $metadata: {} })
}

/** In-memory SES for tests: identities, sandbox flag, captured sends, injectable failures. */
export class FakeSes {
  identities = new Map<string, IdentityInfo>()
  created: string[] = []
  sent: SesSendInput[] = []
  credentials: SesCredentials[] = []
  sandbox = false
  failAccount: Error | null = null
  failSend: Error | null = null

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
    }
    return api
  }
}
