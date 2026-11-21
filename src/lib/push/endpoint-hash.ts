/**
 * Which listed device is this one: the server lists a person's devices by the
 * SHA-256 of their push endpoint, the page hashes its own endpoint the same
 * way. The endpoint itself (a capability URL) never goes back to the page.
 * Web Crypto, so the same code runs in the browser and on the server.
 */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
