import { configManager } from '@/lib/admin/config-manager';

const DEFAULT_SCOPES = 'openid email profile';

/**
 * Resolve the OAuth scopes to request at authorize time.
 *
 * Reads admin override / OAUTH_SCOPES / OAUTH_EXTRA_SCOPES at call time so
 * runtime env vars (and admin dashboard changes) take effect without a rebuild.
 * Server-only: callers in the browser must read `oauthScopes` from /api/config.
 */
export function getOauthScopes(): string {
  const explicit = configManager.get<string>('oauthScopes', '');
  if (explicit) return explicit;
  const extra = configManager.get<string>('oauthExtraScopes', '');
  return extra ? `${DEFAULT_SCOPES} ${extra}`.trim() : DEFAULT_SCOPES;
}
export const REFRESH_TOKEN_COOKIE = 'jmap_rt';
export const REFRESH_TOKEN_SERVER_COOKIE = 'jmap_rts';

/** Get the cookie name for a given account slot. Slot 0 uses the legacy name. */
export function refreshTokenCookieName(slot: number): string {
  return slot === 0 ? REFRESH_TOKEN_COOKIE : `${REFRESH_TOKEN_COOKIE}_${slot}`;
}

/** Companion cookie storing which server entry id minted the refresh token at this slot. */
export function refreshTokenServerCookieName(slot: number): string {
  return slot === 0 ? REFRESH_TOKEN_SERVER_COOKIE : `${REFRESH_TOKEN_SERVER_COOKIE}_${slot}`;
}
