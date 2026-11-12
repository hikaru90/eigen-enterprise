import type { SesCredentials } from './ses'
import {
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3'
import { awsErrorCode } from './ses'

/**
 * The S3 bucket SES writes received mail into (plan/email-inbox.md S0 + S2):
 * private (public access blocked), encrypted with SSE-S3, writable only by SES
 * for our own receipt rules. Created in the SES region. Tests use a fake.
 */

export type InboundBucketApi = {
  /**
   * CreateBucket in the client's region. `created: false` when this account
   * already owns it; a bucket of that name in another account throws
   * BucketOwnedElsewhereError.
   */
  create(bucket: string): Promise<{ created: boolean }>
  /** PutPublicAccessBlock with all four switches on. */
  blockPublicAccess(bucket: string): Promise<void>
  /** PutBucketEncryption: SSE-S3 (AES256), no customer KMS key. */
  encrypt(bucket: string): Promise<void>
  /** PutBucketPolicy with the policy document as JSON. */
  putPolicy(bucket: string, policy: object): Promise<void>
}

export type InboundBucketFactory = (credentials: SesCredentials) => InboundBucketApi

/** The bucket name is taken by another AWS account (bucket names are global). */
export class BucketOwnedElsewhereError extends Error {
  constructor(readonly bucket: string) {
    super(`The S3 bucket name ${bucket} belongs to another AWS account.`)
    this.name = 'BucketOwnedElsewhereError'
  }
}

/** Where SES writes: one bucket per AWS account and region (≤ 63 characters, lowercase). */
export function inboundBucketName(accountId: string, region: string): string {
  return `ee-inbound-${accountId}-${region}`.toLowerCase()
}

/** Lets SES put mail into the bucket, and only for our own rule set in our own account. */
export function inboundBucketPolicy(input: { bucket: string; accountId: string; region: string; ruleSet: string }): object {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowSESPuts',
        Effect: 'Allow',
        Principal: { Service: 'ses.amazonaws.com' },
        Action: 's3:PutObject',
        Resource: `arn:aws:s3:::${input.bucket}/*`,
        Condition: {
          StringEquals: {
            'AWS:SourceAccount': input.accountId,
          },
          ArnLike: {
            'AWS:SourceArn': `arn:aws:ses:${input.region}:${input.accountId}:receipt-rule-set/${input.ruleSet}:receipt-rule/*`,
          },
        },
      },
    ],
  }
}

export const awsInboundBucket: InboundBucketFactory = (c) => {
  const client = new S3Client({
    region: c.region,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  })
  return {
    async create(bucket) {
      try {
        await client.send(
          new CreateBucketCommand({
            Bucket: bucket,
            // us-east-1 is the default location and must not be named.
            ...(c.region === 'us-east-1'
              ? {}
              : { CreateBucketConfiguration: { LocationConstraint: c.region as BucketLocationConstraint } }),
          }),
        )
        return { created: true }
      } catch (err) {
        const code = awsErrorCode(err)
        if (code === 'BucketAlreadyOwnedByYou') return { created: false }
        if (code === 'BucketAlreadyExists') throw new BucketOwnedElsewhereError(bucket)
        throw err
      }
    },
    async blockPublicAccess(bucket) {
      await client.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
      )
    },
    async encrypt(bucket) {
      await client.send(
        new PutBucketEncryptionCommand({
          Bucket: bucket,
          ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        }),
      )
    },
    async putPolicy(bucket, policy) {
      await client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }))
    },
  }
}
