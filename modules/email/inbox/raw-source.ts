import type { SesCredentials } from '../owlery/ses'
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

/**
 * Where the raw MIME of a received mail is read from: the company's inbound
 * bucket, written by the SES receipt rule's S3 action (plan/email-inbox.md S0).
 * Live = S3 GetObject with the company's SES keys and region; tests use the fake.
 */
export type RawMailSource = {
  /** The object's bytes. Throws when it can't be read (the ingest route answers 5xx so SNS retries). */
  getRaw(bucket: string, key: string): Promise<Uint8Array>
}

/** A raw source that can also delete an object (managed mode: unrouted mail is deleted, D7). */
export type DeletableRawMailSource = RawMailSource & { deleteRaw(bucket: string, key: string): Promise<void> }

/** The object is larger than SES receiving ever writes (40 MB): not ours to parse. */
export class RawMailTooLarge extends Error {
  constructor(readonly sizeBytes: number) {
    super(`The received mail object is ${sizeBytes} bytes, over the SES receiving cap.`)
    this.name = 'RawMailTooLarge'
  }
}

/**
 * S3 over the company's saved SES credentials (resolved per call, so a key
 * change applies at once). An object over `maxBytes` is refused before its body is read.
 */
export function s3RawMailSource(credentials: () => Promise<SesCredentials>, maxBytes: number): DeletableRawMailSource {
  const client = async () => {
    const c = await credentials()
    return new S3Client({ region: c.region, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } })
  }
  return {
    async deleteRaw(bucket, key) {
      const s3 = await client()
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      } finally {
        s3.destroy()
      }
    },
    async getRaw(bucket, key) {
      const c = await credentials()
      const client = new S3Client({ region: c.region, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } })
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        if (out.ContentLength !== undefined && out.ContentLength > maxBytes) {
          throw new RawMailTooLarge(out.ContentLength)
        }
        if (!out.Body) throw new Error(`S3 returned no body for the received mail ${key}`)
        return await out.Body.transformToByteArray()
      } finally {
        client.destroy()
      }
    },
  }
}

/** In-memory objects keyed `bucket/key`; `reads` lists every read in order. */
export function fakeRawMailSource(): DeletableRawMailSource & { objects: Map<string, Uint8Array>; reads: string[]; deleted: string[] } {
  const objects = new Map<string, Uint8Array>()
  const reads: string[] = []
  const deleted: string[] = []
  return {
    objects,
    reads,
    deleted,
    async deleteRaw(bucket, key) {
      deleted.push(`${bucket}/${key}`)
      objects.delete(`${bucket}/${key}`)
    },
    async getRaw(bucket, key) {
      reads.push(`${bucket}/${key}`)
      const hit = objects.get(`${bucket}/${key}`)
      if (!hit) throw new Error(`no object ${bucket}/${key}`)
      return new Uint8Array(hit)
    },
  }
}

const processHost = globalThis as { __eeFakeRawMail?: ReturnType<typeof fakeRawMailSource> }

/**
 * The inbound bucket of MAIL_TRANSPORT=fake (test servers only): one in-memory
 * object store per process, filled by the e2e inbox harness, read by
 * downloads, forwards and ingest exactly like S3 would be.
 */
export function processFakeRawMailSource(): ReturnType<typeof fakeRawMailSource> {
  processHost.__eeFakeRawMail ??= fakeRawMailSource()
  return processHost.__eeFakeRawMail
}
