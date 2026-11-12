import type { InboundBucketApi, InboundBucketFactory } from './inbound-bucket'
import type { InboundRule, SesReceivingApi, SesReceivingFactory } from './ses-receiving'
import { awsError } from './fake-ses'
import { BucketOwnedElsewhereError } from './inbound-bucket'

/**
 * In-memory SES receipt rules and S3 bucket: the unit-test fakes, and (one
 * process-wide instance each) the receiving side of MAIL_TRANSPORT=fake. They
 * keep the state real Amazon would keep — rule sets, the active one, rules,
 * buckets with their settings — and fail like Amazon when told to.
 */

export class FakeSesReceiving {
  ruleSets = new Map<string, InboundRule[]>()
  active: string | null = null
  /** Every mutating call, in order, e.g. "createRule ee-inbound ee-inbound-1". */
  calls: string[] = []
  /** Fail the named method (activeRuleSet, createRuleSet, createRule …) with this error. */
  failures = new Map<keyof SesReceivingApi, Error>()

  private fail(method: keyof SesReceivingApi) {
    const err = this.failures.get(method)
    if (err) throw err
  }

  private rules(ruleSet: string): InboundRule[] {
    const rules = this.ruleSets.get(ruleSet)
    if (!rules) throw awsError('RuleSetDoesNotExistException', `Rule set does not exist: ${ruleSet}`)
    return rules
  }

  factory: SesReceivingFactory = () => {
    const api: SesReceivingApi = {
      activeRuleSet: async () => {
        this.fail('activeRuleSet')
        return this.active
      },
      createRuleSet: async (name) => {
        this.fail('createRuleSet')
        this.calls.push(`createRuleSet ${name}`)
        if (!this.ruleSets.has(name)) this.ruleSets.set(name, [])
      },
      activateRuleSet: async (name) => {
        this.fail('activateRuleSet')
        this.rules(name)
        this.calls.push(`activateRuleSet ${name}`)
        this.active = name
      },
      listRules: async (ruleSet) => {
        this.fail('listRules')
        return structuredClone(this.rules(ruleSet))
      },
      createRule: async (ruleSet, rule) => {
        this.fail('createRule')
        const rules = this.rules(ruleSet)
        if (rules.some((r) => r.name === rule.name)) throw awsError('AlreadyExistsException', `Rule exists: ${rule.name}`)
        this.calls.push(`createRule ${ruleSet} ${rule.name}`)
        rules.push(structuredClone(rule))
      },
      updateRule: async (ruleSet, rule) => {
        this.fail('updateRule')
        const rules = this.rules(ruleSet)
        const i = rules.findIndex((r) => r.name === rule.name)
        if (i < 0) throw awsError('RuleDoesNotExistException', `Rule does not exist: ${rule.name}`)
        this.calls.push(`updateRule ${ruleSet} ${rule.name}`)
        rules[i] = structuredClone(rule)
      },
      deleteRule: async (ruleSet, name) => {
        this.fail('deleteRule')
        const rules = this.rules(ruleSet)
        this.calls.push(`deleteRule ${ruleSet} ${name}`)
        this.ruleSets.set(
          ruleSet,
          rules.filter((r) => r.name !== name),
        )
      },
    }
    return api
  }
}

export type FakeBucket = { region: string; publicAccessBlocked: boolean; encrypted: boolean; policy: object | null }

export class FakeInboundBucket {
  buckets = new Map<string, FakeBucket>()
  /** Bucket names another AWS account already holds. */
  foreign = new Set<string>()
  failures = new Map<keyof InboundBucketApi, Error>()

  private fail(method: keyof InboundBucketApi) {
    const err = this.failures.get(method)
    if (err) throw err
  }

  private bucket(name: string): FakeBucket {
    const b = this.buckets.get(name)
    if (!b) throw awsError('NoSuchBucket', `The specified bucket does not exist: ${name}`)
    return b
  }

  factory: InboundBucketFactory = (c) => {
    const api: InboundBucketApi = {
      create: async (name) => {
        this.fail('create')
        if (this.foreign.has(name)) throw new BucketOwnedElsewhereError(name)
        if (this.buckets.has(name)) return { created: false }
        this.buckets.set(name, { region: c.region, publicAccessBlocked: false, encrypted: false, policy: null })
        return { created: true }
      },
      blockPublicAccess: async (name) => {
        this.fail('blockPublicAccess')
        this.bucket(name).publicAccessBlocked = true
      },
      encrypt: async (name) => {
        this.fail('encrypt')
        this.bucket(name).encrypted = true
      },
      putPolicy: async (name, policy) => {
        this.fail('putPolicy')
        this.bucket(name).policy = structuredClone(policy)
      },
    }
    return api
  }
}

const host = globalThis as { __eeFakeReceiving?: { ses: FakeSesReceiving; bucket: FakeInboundBucket } }

/** The process-wide fakes behind MAIL_TRANSPORT=fake (Amazon's state lives in memory, like Amazon's own). */
export function fakeTransportReceiving(): { ses: FakeSesReceiving; bucket: FakeInboundBucket } {
  host.__eeFakeReceiving ??= { ses: new FakeSesReceiving(), bucket: new FakeInboundBucket() }
  return host.__eeFakeReceiving
}
