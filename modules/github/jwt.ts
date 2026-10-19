import { createSign } from 'node:crypto'

/** RS256 app JWT (GitHub: iat backdated 60s for clock drift, max lifetime 10 minutes). */
export function githubAppJwt(appId: number, privateKeyPem: string, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000) - 60
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat, exp: iat + 9 * 60, iss: String(appId) })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKeyPem).toString('base64url')
  return `${unsigned}.${signature}`
}
