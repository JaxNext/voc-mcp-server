// Per-request Voc access, injected into every tool (§8). Identity comes from
// the Worker — never from tool input. The `/mcp` api handler (src/provider.ts)
// builds the session from the provider-attached grant props + VOC_SESSIONS KV,
// refreshing the Voc credential on expiry before a tool ever runs (§7.3); the
// tests stub it.

import type { PostgrestClient } from '../../voc/postgrest'

export interface VocSession {
  /** RLS-scoped client bound to the calling user's Voc JWT (§5.1). */
  client: PostgrestClient
  /** The calling user's id (JWT `sub` claim). */
  userId: string
}

/** Resolved fresh per tool call — the underlying credential may refresh. */
export type VocSessionFactory = () => Promise<VocSession>
