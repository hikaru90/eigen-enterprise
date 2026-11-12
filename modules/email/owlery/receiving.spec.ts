import { beforeEach, describe, expect, it } from 'vitest'
import { MailNotConfiguredError } from '$lib/server/mail/company-mail'
import { INBOUND_CALLBACK_PATH, INBOUND_RULE_SET, INBOUND_TOPIC_NAME } from '../inbox/receiving-contract'
import { FakeInboundBucket, FakeSesReceiving } from './fake-receiving'
import { awsError, FakeSns } from './fake-ses'
import { inboundBucketName, inboundBucketPolicy } from './inbound-bucket'
import { accountIdFromArn, ReceivingService, ReceivingSetupError, receivingIamPolicy } from './receiving'
import { awsSns, EventsSetupError } from './sns'
import { InMemoryOwleryStore, NO_EVENTS } from './store'

const creds = { region: 'eu-central-1', accessKeyId: 'AKIA', secretAccessKey: 's' }
const BUCKET = 'ee-inbound-000000000000-eu-central-1'
const TOPIC = `arn:aws:sns:eu-central-1:000000000000:${INBOUND_TOPIC_NAME}`
const ORIGIN = 'https://os.kindred.test'

let ses: FakeSesReceiving
let bucket: FakeInboundBucket
let sns: FakeSns
let store: InMemoryOwleryStore
let connected: boolean
let service: ReceivingService

beforeEach(async () => {
  ses = new FakeSesReceiving()
  bucket = new FakeInboundBucket()
  sns = new FakeSns()
  store = new InMemoryOwleryStore()
  await store.write({ region: 'eu-central-1', accessKeyId: 'AKIA', sealedSecretAccessKey: 'x', emailFrom: 'hello@kindred.test', updatedBy: 'u1' })
  connected = true
  service = new ReceivingService({
    store,
    credentials: async () => (connected ? creds : null),
    ses: ses.factory,
    bucket: bucket.factory,
    sns: sns.factory,
  })
})

const addresses = (n: number) => Array.from({ length: n }, (_, i) => `user${String(i + 1).padStart(3, '0')}@kindred.com`)

describe('names and policies', () => {
  it('reads the account id from an ARN and names the bucket after account and region', () => {
    expect(accountIdFromArn('arn:aws:sns:eu-central-1:123456789012:ee-inbound')).toBe('123456789012')
    expect(() => accountIdFromArn('not-an-arn')).toThrow(/ARN/)
    expect(inboundBucketName('123456789012', 'eu-central-1')).toBe('ee-inbound-123456789012-eu-central-1')
  })

  it('lets only SES, for our own rule set in our own account, write into the bucket', () => {
    expect(inboundBucketPolicy({ bucket: BUCKET, accountId: '000000000000', region: 'eu-central-1', ruleSet: 'ee-inbound' })).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowSESPuts',
          Effect: 'Allow',
          Principal: { Service: 'ses.amazonaws.com' },
          Action: 's3:PutObject',
          Resource: `arn:aws:s3:::${BUCKET}/*`,
          Condition: {
            StringEquals: { 'AWS:SourceAccount': '000000000000' },
            ArnLike: { 'AWS:SourceArn': 'arn:aws:ses:eu-central-1:000000000000:receipt-rule-set/ee-inbound:receipt-rule/*' },
          },
        },
      ],
    })
  })

  it('the IAM policy grants the S3 actions on the inbound bucket only', () => {
    const policy = receivingIamPolicy(BUCKET) as { Statement: Array<{ Action: string[]; Resource: string[] }> }
    expect(policy.Statement).toEqual([
      {
        Sid: 'EeInboundBucket',
        Effect: 'Allow',
        Action: ['s3:CreateBucket', 's3:PutBucketPolicy', 's3:PutBucketPublicAccessBlock', 's3:PutEncryptionConfiguration'],
        Resource: [`arn:aws:s3:::${BUCKET}`],
      },
      {
        Sid: 'EeInboundMail',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:DeleteObject'],
        Resource: [`arn:aws:s3:::${BUCKET}/*`],
      },
    ])
  })
})

describe('ReceivingService.setup', () => {
  it('creates the topic, a private encrypted bucket, the subscription and the active rule set, then the rules', async () => {
    const out = await service.setup(ORIGIN, ['ana@kindred.com'])
    expect(out).toEqual({
      receivingStatus: 'waiting',
      receivingError: null,
      receivingTopicArn: TOPIC,
      receivingBucket: BUCKET,
      receivingRuleSet: INBOUND_RULE_SET,
      receivingCallbackUrl: `${ORIGIN}${INBOUND_CALLBACK_PATH}`,
    })
    expect(store.row).toMatchObject(out)
    expect(sns.topics).toEqual([TOPIC])
    expect(sns.subscriptions).toEqual([{ topicArn: TOPIC, endpoint: `${ORIGIN}${INBOUND_CALLBACK_PATH}` }])
    expect(bucket.buckets.get(BUCKET)).toEqual({
      region: 'eu-central-1',
      publicAccessBlocked: true,
      encrypted: true,
      policy: inboundBucketPolicy({ bucket: BUCKET, accountId: '000000000000', region: 'eu-central-1', ruleSet: INBOUND_RULE_SET }),
    })
    expect(ses.active).toBe(INBOUND_RULE_SET)
    expect(ses.ruleSets.get(INBOUND_RULE_SET)).toEqual([
      { name: 'ee-inbound-1', recipients: ['ana@kindred.com'], bucket: BUCKET, topicArn: TOPIC },
    ])
  })

  it('stores the topic before subscribing, so an early SNS confirmation finds it', async () => {
    let seen: unknown = 'not called'
    const real = sns.factory
    sns.factory = (c) => ({
      ...real(c),
      subscribeHttps: async () => {
        seen = store.row?.receivingTopicArn
        // S3's callback confirms while Subscribe is still in flight.
        await store.writeReceiving({ receivingStatus: 'ready' })
        return { confirmed: false }
      },
    })
    service = new ReceivingService({ store, credentials: async () => creds, ses: ses.factory, bucket: bucket.factory, sns: sns.factory })
    const out = await service.setup(ORIGIN, [])
    expect(seen).toBe(TOPIC)
    // The confirmation that arrived first is not overwritten with "waiting".
    expect(out.receivingStatus).toBe('ready')
    expect(store.row?.receivingStatus).toBe('ready')
  })

  it('is ready at once when SNS reports the subscription as confirmed (a re-run)', async () => {
    sns.confirmImmediately = true
    expect((await service.setup(ORIGIN, [])).receivingStatus).toBe('ready')
  })

  it('re-running reuses everything: an owned bucket and an existing rule set are fine', async () => {
    await service.setup(ORIGIN, ['ana@kindred.com'])
    ses.calls = []
    const again = await service.setup(ORIGIN, ['ana@kindred.com'])
    expect(again.receivingStatus).toBe('waiting')
    expect(again.receivingError).toBeNull()
    expect(ses.ruleSets.get(INBOUND_RULE_SET)).toHaveLength(1)
    expect(ses.calls.filter((c) => c.startsWith('createRule '))).toEqual([])
  })

  it('never replaces another active rule set: stops before creating anything', async () => {
    ses.ruleSets.set('google-forwarding', [])
    ses.active = 'google-forwarding'
    const out = await service.setup(ORIGIN, ['ana@kindred.com'])
    expect(out.receivingStatus).toBe('failed')
    expect(out.receivingError).toMatch(/already receives mail with another receipt rule set \("google-forwarding"\)/)
    expect(out.receivingError).toMatch(/won.t replace it/)
    expect(ses.active).toBe('google-forwarding')
    expect(sns.topics).toEqual([])
    expect(bucket.buckets.size).toBe(0)
  })

  it('a bucket name owned by another account is an explicit error', async () => {
    bucket.foreign.add(BUCKET)
    const out = await service.setup(ORIGIN, [])
    expect(out.receivingStatus).toBe('failed')
    expect(out.receivingError).toMatch(new RegExp(`${BUCKET} belongs to another AWS account`))
    expect(ses.active).toBeNull()
  })

  it('a missing S3 permission names the permission and points at the IAM policy', async () => {
    bucket.failures.set('putPolicy', awsError('AccessDenied', 'Access Denied'))
    const out = await service.setup(ORIGIN, [])
    expect(out.receivingStatus).toBe('failed')
    expect(out.receivingError).toMatch(/s3:PutBucketPolicy/)
    expect(out.receivingError).toMatch(/IAM policy shown under Receiving/)
    // The topic was stored when it was created; the bucket only once it is ready.
    expect(store.row).toMatchObject({ receivingTopicArn: TOPIC, receivingBucket: null })
  })

  it('missing SNS and SES permissions come back in plain words', async () => {
    sns.failSubscribe = awsError('AuthorizationErrorException')
    expect((await service.setup(ORIGIN, [])).receivingError).toMatch(/AmazonSNSFullAccess/)
    sns.failSubscribe = null
    ses.failures.set('createRuleSet', awsError('AccessDenied'))
    expect((await service.setup(ORIGIN, [])).receivingError).toMatch(/receipt rules.*AmazonSESFullAccess/)
  })

  it('real SNS refuses a callback that is not https; the reason reaches the owner as is', async () => {
    await expect(awsSns(creds).subscribeHttps(TOPIC, 'http://localhost:5173/api/mail/ses-inbound')).rejects.toThrow(
      'Amazon only delivers to an https address, and this callback is http://localhost:5173/api/mail/ses-inbound.',
    )
    sns.failSubscribe = new EventsSetupError('Amazon only delivers to an https address, and this callback is http://x.')
    const out = await service.setup('http://x', [])
    expect(out).toMatchObject({ receivingStatus: 'failed', receivingError: 'Amazon only delivers to an https address, and this callback is http://x.' })
  })

  it('failing rules after setup fail the setup with the reason', async () => {
    ses.failures.set('createRule', awsError('InvalidS3ConfigurationException', 'Could not write to bucket'))
    const out = await service.setup(ORIGIN, ['ana@kindred.com'])
    expect(out.receivingStatus).toBe('failed')
    expect(out.receivingError).toMatch(new RegExp(`may not write into the S3 bucket ${BUCKET}`))
  })

  it('needs Amazon SES connected first', async () => {
    connected = false
    await expect(service.setup(ORIGIN, [])).rejects.toBeInstanceOf(MailNotConfiguredError)
  })
})

describe('ReceivingService.syncRules', () => {
  beforeEach(async () => {
    await service.setup(ORIGIN, [])
    ses.calls = []
  })

  it('chunks the recipients into rules of at most 100, sorted and de-duplicated', async () => {
    const all = addresses(250)
    expect(await service.syncRules([...all].reverse().concat(all[0]!))).toEqual({ rules: 3 })
    const rules = ses.ruleSets.get(INBOUND_RULE_SET)!
    expect(rules.map((r) => [r.name, r.recipients.length])).toEqual([
      ['ee-inbound-1', 100],
      ['ee-inbound-2', 100],
      ['ee-inbound-3', 50],
    ])
    expect(rules[0]!.recipients[0]).toBe('user001@kindred.com')
    expect(rules.every((r) => r.bucket === BUCKET && r.topicArn === TOPIC)).toBe(true)
  })

  it('updates changed rules, leaves equal ones, creates missing ones and deletes surplus ones', async () => {
    await service.syncRules(addresses(250))
    ses.calls = []
    await service.syncRules(addresses(150))
    expect(ses.calls).toEqual([`updateRule ${INBOUND_RULE_SET} ee-inbound-2`, `deleteRule ${INBOUND_RULE_SET} ee-inbound-3`])
    ses.calls = []
    await service.syncRules(addresses(150))
    expect(ses.calls).toEqual([])
  })

  it('zero recipients leaves no rules (SES then blocks the mail), and leaves foreign rules alone', async () => {
    ses.ruleSets.get(INBOUND_RULE_SET)!.push({ name: 'hand-made', recipients: ['x@y.z'], bucket: 'b', topicArn: 't' })
    await service.syncRules(addresses(3))
    expect(await service.syncRules([])).toEqual({ rules: 0 })
    expect(ses.ruleSets.get(INBOUND_RULE_SET)!.map((r) => r.name)).toEqual(['hand-made'])
  })

  it('a failed sync records the error on the receiving state and throws it in plain words; the next success clears it', async () => {
    ses.failures.set('createRule', awsError('AccessDenied'))
    const err = await service.syncRules(addresses(1)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReceivingSetupError)
    expect((err as Error).message).toMatch(/receipt rules/)
    expect(store.row?.receivingError).toBe((err as Error).message)
    expect(store.row?.receivingStatus).toBe('waiting')
    ses.failures.clear()
    await service.syncRules(addresses(1))
    expect(store.row?.receivingError).toBeNull()
  })
})

describe('ReceivingService.syncRules before setup', () => {
  it('nothing to do without recipients', async () => {
    expect(await service.syncRules([])).toEqual({ rules: 0 })
    expect(ses.calls).toEqual([])
  })

  it('recipients without a set-up receiving side are an explicit error', async () => {
    await expect(service.syncRules(['ana@kindred.com'])).rejects.toThrow(/Receiving is not set up yet/)
    connected = false
    store.row = null
    await expect(service.syncRules(['ana@kindred.com'])).rejects.toThrow(/Receiving is not set up yet/)
  })
})

describe('ReceivingService.state', () => {
  it('reports the bucket for the IAM policy: stored, else derived from a known account, else a pattern', async () => {
    expect((await service.state())?.policyBucket).toBe('ee-inbound-*-eu-central-1')
    store.row = { ...store.row!, ...NO_EVENTS, eventsTopicArn: 'arn:aws:sns:eu-central-1:123456789012:x' }
    expect((await service.state())?.policyBucket).toBe('ee-inbound-123456789012-eu-central-1')
    await service.setup(ORIGIN, [])
    expect(await service.state()).toMatchObject({ region: 'eu-central-1', receivingStatus: 'waiting', receivingBucket: BUCKET, policyBucket: BUCKET })
  })

  it('is null before Amazon SES is connected', async () => {
    store.row = null
    expect(await service.state()).toBeNull()
  })
})
