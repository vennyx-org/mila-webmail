import { configManager } from '@/lib/admin/config-manager';

export interface ImpersonationConfig {
  jwtSecret: string;
  masterUser: string;
  masterPassword: string;
  expectedIssuer: string;
}

/**
 * Returns null when impersonation is not configured — the route MUST surface
 * that as a 404 so an unconfigured deployment doesn't expose the endpoint.
 *
 * Required env:
 *   BULWARK_JWT_AUTH_SECRET        (>= 32 chars)
 *   BULWARK_STALWART_MASTER_USER   master account address (e.g. master@example.com)
 *   BULWARK_STALWART_MASTER_PASSWORD
 *
 * Optional env:
 *   BULWARK_JWT_AUTH_ISSUER        (default: "platform-api/webmail")
 */
export function readImpersonationConfig(): ImpersonationConfig | null {
  const jwtSecret = process.env.BULWARK_JWT_AUTH_SECRET ?? '';
  const masterUser = process.env.BULWARK_STALWART_MASTER_USER ?? '';
  const masterPassword = process.env.BULWARK_STALWART_MASTER_PASSWORD ?? '';
  if (!jwtSecret || !masterUser || !masterPassword) return null;
  return {
    jwtSecret,
    masterUser,
    masterPassword,
    expectedIssuer: process.env.BULWARK_JWT_AUTH_ISSUER ?? 'platform-api/webmail',
  };
}

/**
 * Resolves the upstream JMAP server URL the same way /api/auth/session does
 * for trusted entries: the global `jmapServerUrl` admin setting, then the
 * legacy env fallbacks. Returns null if none is configured.
 *
 * The impersonation flow is server-to-server (no user input), so we never
 * accept a custom endpoint — only admin-configured URLs.
 */
export async function resolveImpersonationServerUrl(): Promise<string | null> {
  await configManager.ensureLoaded();
  const url =
    configManager.get<string>('jmapServerUrl', '') ||
    process.env.JMAP_SERVER_URL ||
    process.env.NEXT_PUBLIC_JMAP_SERVER_URL ||
    '';
  return url || null;
}
