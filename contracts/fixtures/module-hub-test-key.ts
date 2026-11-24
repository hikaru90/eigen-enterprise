/**
 * TEST ONLY — an Ed25519 key pair for signing module receipts in tests and
 * stubs (plan/phase-upgrades-u2.md §9.0: stream A's fake PublishPort, stream
 * B's fixture receipts, stream C's mock hub). It is public in this repo, so it
 * proves nothing: no box, no hub and no ee build may ever trust it. The real
 * hub key is the `MODULE_HUB_SIGNING_KEY` ee secret on the hub box.
 */

/** TEST ONLY: base64 DER SPKI of the test hub key. */
export const TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI =
  'MCowBQYDK2VwAyEAxCRl1YDOmSyclnj42Yymcyv1S65avVruNWUQTXH924U='

/** TEST ONLY: base64 DER PKCS#8 of the test hub key. Never used outside tests. */
export const TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8 =
  'MC4CAQAwBQYDK2VwBCIEICvC+heYSzjVXotK175U8YR4xjMJ4O8IY4F4fB0CNn8C'

/** TEST ONLY: the hub origin test receipts name. */
export const TEST_ONLY_MODULE_HUB_ORIGIN = 'https://hub.test'
