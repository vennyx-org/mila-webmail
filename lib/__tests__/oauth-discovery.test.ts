import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuthMetadata } from '../oauth/discovery';

const validateEndpoint = async (urlString: string) => {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^(127\.|169\.254\.|10\.|192\.168\.)/.test(host)) return false;
    if (host === '::1' || host === '0.0.0.0') return false;
    return true;
  } catch {
    return false;
  }
};

const VALID_METADATA: OAuthMetadata = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  revocation_endpoint: 'https://auth.example.com/revoke',
  end_session_endpoint: 'https://auth.example.com/logout',
};

describe('oauth/discovery', () => {
  let discoverOAuth: typeof import('../oauth/discovery').discoverOAuth;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    const mod = await import('../oauth/discovery');
    discoverOAuth = mod.discoverOAuth;
  });

  it('discovers metadata from oauth-authorization-server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(VALID_METADATA),
    }));

    const result = await discoverOAuth('https://mail.example.com', { validateEndpoint });

    expect(result).toEqual(VALID_METADATA);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://mail.example.com/.well-known/oauth-authorization-server'
    );
  });

  it('falls back to openid-configuration when first returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(VALID_METADATA),
      }));

    const result = await discoverOAuth('https://fallback.example.com', { validateEndpoint });

    expect(result).toEqual(VALID_METADATA);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://fallback.example.com/.well-known/openid-configuration'
    );
  });

  it('returns null when both endpoints fail', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await discoverOAuth('https://fail.example.com', { validateEndpoint });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('parses optional fields (revocation_endpoint, end_session_endpoint)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(VALID_METADATA),
    }));

    const result = await discoverOAuth('https://optional.example.com', { validateEndpoint });

    expect(result?.revocation_endpoint).toBe('https://auth.example.com/revoke');
    expect(result?.end_session_endpoint).toBe('https://auth.example.com/logout');
  });

  it('returns null when required fields (authorization_endpoint, token_endpoint) are missing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ issuer: 'https://auth.example.com' }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await discoverOAuth('https://incomplete.example.com', { validateEndpoint });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('rejects metadata pointing at loopback / link-local hosts (SSRF guard)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          issuer: 'https://evil.example.com',
          authorization_endpoint: 'https://evil.example.com/authorize',
          token_endpoint: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await discoverOAuth('https://evil.example.com', { validateEndpoint });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('rejects metadata pointing at private RFC1918 hosts (SSRF guard)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          issuer: 'https://evil.example.com',
          authorization_endpoint: 'https://evil.example.com/authorize',
          token_endpoint: 'https://evil.example.com/token',
          revocation_endpoint: 'http://127.0.0.1:9200/_cluster/state',
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await discoverOAuth('https://private-revoke.example.com', { validateEndpoint });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('caches results - second call for same server URL does not re-fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(VALID_METADATA),
    }));

    const first = await discoverOAuth('https://cached.example.com', { validateEndpoint });
    const second = await discoverOAuth('https://cached.example.com', { validateEndpoint });

    expect(first).toEqual(VALID_METADATA);
    expect(second).toEqual(VALID_METADATA);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
