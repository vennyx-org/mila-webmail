import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { decryptPayload } from '@/lib/auth/crypto';
import { exchangeCodeForTokens } from '@/lib/oauth/token-exchange';
import { refreshTokenCookieName } from '@/lib/oauth/tokens';
import { getCookieOptions } from '@/lib/oauth/cookie-config';

const SSO_PENDING_COOKIE = 'sso_pending';
const SSO_PENDING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();

  try {
    const { code, state, slot: bodySlot } = await request.json();

    if (!code || !state) {
      return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
    }

    // Per-account refresh-token cookie slot. Without this the route hardcoded
    // slot 0, so the "+ Add Account" flow overwrote the first account's
    // refresh-token cookie. Default to 0 for back-compat with any caller that
    // omits slot. Mirrors the validation in /api/auth/token POST.
    const slot = typeof bodySlot === 'number' && bodySlot >= 0 && bodySlot <= 4 ? bodySlot : 0;

    // Read and decrypt the pending SSO cookie
    const pendingCookie = cookieStore.get(SSO_PENDING_COOKIE)?.value;
    if (!pendingCookie) {
      logger.warn('SSO complete: no pending cookie found');
      return NextResponse.json({ error: 'No pending SSO session. Please start the login flow again.' }, { status: 400 });
    }

    const pending = decryptPayload(pendingCookie);
    if (!pending) {
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'Invalid SSO session' }, { status: 400 });
    }

    // Validate state
    if (pending.state !== state) {
      logger.warn('SSO complete: state mismatch');
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'State mismatch' }, { status: 400 });
    }

    // Validate TTL
    const createdAt = pending.created_at as number;
    if (!createdAt || Date.now() - createdAt > SSO_PENDING_MAX_AGE_MS) {
      logger.warn('SSO complete: pending session expired');
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'SSO session expired. Please try again.' }, { status: 400 });
    }

    const codeVerifier = pending.code_verifier as string;
    const redirectUri = pending.redirect_uri as string;

    if (!codeVerifier || !redirectUri) {
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'Invalid SSO session data' }, { status: 400 });
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, codeVerifier, redirectUri);

    // Store refresh token in the per-account cookie slot.
    if (tokens.refresh_token) {
      const cookieName = refreshTokenCookieName(slot);
      cookieStore.set(cookieName, tokens.refresh_token, getCookieOptions());
    }

    // Delete pending cookie
    cookieStore.delete(SSO_PENDING_COOKIE);

    return NextResponse.json({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
    });
  } catch (error) {
    // Clean up pending cookie on any error
    cookieStore.delete(SSO_PENDING_COOKIE);
    logger.error('SSO complete error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 401 });
  }
}
