// Voc credential custody (tech-design §7.3).
//
// The OAuth provider encrypts grant props and writes them once — they cannot
// hold a rotating refresh token. Props therefore carry only the stable identity
// (§7.4 of handler.ts), and the live credential set lives here, in its own KV
// namespace, keyed by the Voc user id.
//
// Task 6 adds refresh-on-expiry and the 401-with-challenge recovery on top of
// this module; it stays deliberately dumb storage until then.

export interface VocTokenSession {
  refresh_token: string
  access_token: string
  /** Unix seconds at which `access_token` expires. */
  expires_at: number
  /** Space-separated scope string as issued by Voc, or null. */
  scope: string | null
}

export async function getVocSession(kv: KVNamespace, vocUserId: string): Promise<VocTokenSession | null> {
  return kv.get<VocTokenSession>(vocUserId, 'json')
}

export async function putVocSession(kv: KVNamespace, vocUserId: string, session: VocTokenSession): Promise<void> {
  await kv.put(vocUserId, JSON.stringify(session))
}

export async function deleteVocSession(kv: KVNamespace, vocUserId: string): Promise<void> {
  await kv.delete(vocUserId)
}
