// Per-request Voc access, injected into every tool (§8). Identity comes from
// the Worker — never from tool input. Task 5 builds the session from
// `authInfo.props` + VOC_SESSIONS KV; Task 3's dev wiring and the tests stub it.

import type { PostgrestClient } from '../../voc/postgrest'

export interface VocSession {
  /** RLS-scoped client bound to the calling user's Voc JWT (§5.1). */
  client: PostgrestClient
  /** The calling user's id (JWT `sub` claim). */
  userId: string
}

/** Resolved fresh per tool call — the underlying credential may refresh. */
export type VocSessionFactory = () => Promise<VocSession>
