import type { SesCredentials } from './ses'
import {
  CreateReceiptRuleCommand,
  CreateReceiptRuleSetCommand,
  DeleteReceiptRuleCommand,
  DescribeActiveReceiptRuleSetCommand,
  DescribeReceiptRuleSetCommand,
  SESClient,
  SetActiveReceiptRuleSetCommand,
  UpdateReceiptRuleCommand,
  type ReceiptRule,
} from '@aws-sdk/client-ses'
import { awsErrorCode } from './ses'

/**
 * Amazon SES receipt rules (plan/email-inbox.md S2). Receipt rules exist only
 * in the SES v1 API, so this is the one place that uses it. Everything above it
 * works against `SesReceivingApi` so tests inject a fake.
 *
 * Every rule ee writes has the same shape: the recipients it accepts, spam and
 * virus scanning on, TLS optional, and one S3 action that stores the raw mail
 * in our bucket and then notifies our SNS topic (the S3 action carries mail up
 * to 40 MB; a separate SNS action would bounce anything over 150 KB).
 */

/** One of our rules: its name, the exact addresses it accepts, where the mail goes. */
export type InboundRule = { name: string; recipients: string[]; bucket: string; topicArn: string }

export type SesReceivingApi = {
  /** DescribeActiveReceiptRuleSet — the active set's name, or null when none is active. */
  activeRuleSet(): Promise<string | null>
  /** CreateReceiptRuleSet; an existing set of that name counts as created. */
  createRuleSet(name: string): Promise<void>
  /** SetActiveReceiptRuleSet. */
  activateRuleSet(name: string): Promise<void>
  /** DescribeReceiptRuleSet — the rules in the set, in order. */
  listRules(ruleSet: string): Promise<InboundRule[]>
  createRule(ruleSet: string, rule: InboundRule): Promise<void>
  updateRule(ruleSet: string, rule: InboundRule): Promise<void>
  deleteRule(ruleSet: string, name: string): Promise<void>
}

export type SesReceivingFactory = (credentials: SesCredentials) => SesReceivingApi

function toAws(rule: InboundRule): ReceiptRule {
  return {
    Name: rule.name,
    Enabled: true,
    ScanEnabled: true,
    TlsPolicy: 'Optional',
    Recipients: rule.recipients,
    Actions: [{ S3Action: { BucketName: rule.bucket, TopicArn: rule.topicArn } }],
  }
}

function fromAws(rule: ReceiptRule): InboundRule {
  const s3 = rule.Actions?.find((a) => a.S3Action)?.S3Action
  return {
    name: rule.Name ?? '',
    recipients: rule.Recipients ?? [],
    bucket: s3?.BucketName ?? '',
    topicArn: s3?.TopicArn ?? '',
  }
}

export const awsSesReceiving: SesReceivingFactory = (c) => {
  const client = new SESClient({
    region: c.region,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  })
  return {
    async activeRuleSet() {
      const out = await client.send(new DescribeActiveReceiptRuleSetCommand({}))
      return out.Metadata?.Name ?? null
    },
    async createRuleSet(name) {
      try {
        await client.send(new CreateReceiptRuleSetCommand({ RuleSetName: name }))
      } catch (err) {
        if (awsErrorCode(err) !== 'AlreadyExistsException') throw err
      }
    },
    async activateRuleSet(name) {
      await client.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: name }))
    },
    async listRules(ruleSet) {
      const out = await client.send(new DescribeReceiptRuleSetCommand({ RuleSetName: ruleSet }))
      return (out.Rules ?? []).map(fromAws)
    },
    async createRule(ruleSet, rule) {
      await client.send(new CreateReceiptRuleCommand({ RuleSetName: ruleSet, Rule: toAws(rule) }))
    },
    async updateRule(ruleSet, rule) {
      await client.send(new UpdateReceiptRuleCommand({ RuleSetName: ruleSet, Rule: toAws(rule) }))
    },
    async deleteRule(ruleSet, name) {
      await client.send(new DeleteReceiptRuleCommand({ RuleSetName: ruleSet, RuleName: name }))
    },
  }
}
