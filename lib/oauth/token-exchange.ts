import { logger } from '@/lib/logger';
import { discoverOAuth } from '@/lib/oauth/discovery';
import type { OAuthMetadata } from '@/lib/oauth/discovery';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { readFileEnv } from '@/lib/read-file-env';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, findServerById } from '@/lib/admin/jmap-servers';

function getGlobalClientSecret(): string {
  const adminSecret = configManager.get<string>('oauthClientSecret', '');
  if (adminSecret) return adminSecret;
  return process.env.OAUTH_CLIENT_SECRET || readFileEnv(process.env.OAUTH_CLIENT_SECRET_FILE) || '';
}

function getServerEntry(serverId?: string | null) {
  if (!serverId) return undefined;
  const servers = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  return findServerById(servers, serverId);
}

export function getRequiredConfig(serverId?: string | null) {
  const entry = getServerEntry(serverId);

  const globalClientId = configManager.get<string>('oauthClientId', '') || process.env.OAUTH_CLIENT_ID;
  const globalServerUrl = configManager.get<string>('jmapServerUrl', '') || process.env.JMAP_SERVER_URL || process.env.NEXT_PUBLIC_JMAP_SERVER_URL;
  const globalIssuerUrl = configManager.get<string>('oauthIssuerUrl', '') || process.env.OAUTH_ISSUER_URL;

  const clientId = entry?.oauth?.clientId || globalClientId;
  const serverUrl = entry?.url || globalServerUrl;
  const issuerUrl = entry?.oauth?.issuerUrl || globalIssuerUrl;

  if (!clientId || !serverUrl) {
    throw new Error(`OAuth misconfigured: ${[!clientId && 'OAUTH_CLIENT_ID', !serverUrl && 'JMAP_SERVER_URL'].filter(Boolean).join(', ')} not set`);
  }
  const discoveryUrl = issuerUrl?.trim() || serverUrl;
  if (issuerUrl !== undefined && issuerUrl !== '' && !issuerUrl.trim()) {
    logger.warn('OAUTH_ISSUER_URL is set but empty, falling back to JMAP_SERVER_URL for discovery');
  }
  return { clientId, serverUrl, discoveryUrl, serverId: entry?.id };
}

function getClientSecret(serverId?: string | null): string {
  const entry = getServerEntry(serverId);
  if (entry?.oauth?.clientSecret) return entry.oauth.clientSecret;
  return getGlobalClientSecret();
}

export async function getTokenEndpoint(serverId?: string | null): Promise<string> {
  const { discoveryUrl } = getRequiredConfig(serverId);
  const metadata = await discoverOAuth(discoveryUrl, { validateEndpoint: isPublicHttpUrl });
  if (!metadata?.token_endpoint) {
    throw new Error('OAuth token endpoint not found');
  }
  return metadata.token_endpoint;
}

export async function getMetadata(serverId?: string | null): Promise<OAuthMetadata | null> {
  const { discoveryUrl } = getRequiredConfig(serverId);
  return discoverOAuth(discoveryUrl, { validateEndpoint: isPublicHttpUrl });
}

export function buildOAuthParams(base: Record<string, string>, serverId?: string | null): URLSearchParams {
  const { clientId } = getRequiredConfig(serverId);
  const params = new URLSearchParams({ ...base, client_id: clientId });
  const secret = getClientSecret(serverId);
  if (secret) {
    params.set('client_secret', secret);
  }
  return params;
}

export interface TokenResult {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  serverId?: string | null,
): Promise<TokenResult> {
  const tokenEndpoint = await getTokenEndpoint(serverId);

  const params = buildOAuthParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  }, serverId);

  const tokenResponse = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    logger.error('Token exchange failed', { status: tokenResponse.status, error: errorText });
    throw new Error('Token exchange failed');
  }

  const tokens = await tokenResponse.json();

  if (!tokens.access_token) {
    logger.error('Token response missing access_token', { response: JSON.stringify(tokens).substring(0, 500) });
    throw new Error('Invalid token response');
  }

  return {
    access_token: tokens.access_token,
    expires_in: tokens.expires_in || 3600,
    refresh_token: tokens.refresh_token,
  };
}
