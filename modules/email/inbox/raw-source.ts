import type { SesCredentials } from '../owlery/ses'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

/**
 * Where the raw MIME of a received mail is read from: the company's inbound
 * bucket, written by the SES receipt rule's S3 action (plan/email-inbox.md S0).
 * Live = S3 GetObject with the company's SES keys and region; tests use the fake.
 */
export type RawMailSource = {
  /** The object's bytes. Throws when it can't be read (the ingest route answers 5xx so SNS retries). */
  getRaw(bucket: string, key: string): Promise<Uint8Array>
}

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
export function s3RawMailSource(credentials: () => Promise<SesCredentials>, maxBytes: number): RawMailSource {
  return {
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
export function fakeRawMailSource(): RawMailSource & { objects: Map<string, Uint8Array>; reads: string[] } {
  const objects = new Map<string, Uint8Array>()
  const reads: string[] = []
  return {
    objects,
    reads,
    async getRaw(bucket, key) {
      reads.push(`${bucket}/${key}`)
      const hit = objects.get(`${bucket}/${key}`)
      if (!hit) throw new Error(`no object ${bucket}/${key}`)
      return new Uint8Array(hit)
    },
  }
}
