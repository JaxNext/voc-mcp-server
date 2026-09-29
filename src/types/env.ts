export interface Env {
  /** `@cloudflare/workers-oauth-provider` state: clients, grants, tokens (§7.1). */
  OAUTH_KV: KVNamespace
  /** Voc credential custody: refresh + access tokens keyed by `voc_user_id` (§7.3). */
  VOC_SESSIONS: KVNamespace

  /** Supabase project behind Voc (PostgREST + OAuth server). */
  VOC_SUPABASE_URL: string
  /** Client id registered in Supabase → Authentication → OAuth Apps (§7.4). */
  VOC_OAUTH_CLIENT_ID: string
  /** Exact redirect URI registered against the client above — no wildcards. */
  VOC_REDIRECT_URI: string
}
