import { cookies } from 'next/headers';
import { verifySetupToken } from './token';

export const SETUP_COOKIE = 'bulwark_setup_token';
const COOKIE_MAX_AGE = 60 * 60; // 1 hour, matches token TTL

/**
 * The wizard "session" is just the setup token itself, set as an HttpOnly
 * cookie after the operator pastes it into step 1. Subsequent step calls
 * re-verify the cookie value against the .setup-token file. When the wizard
 * finishes, the token file is deleted and any cookies become useless.
 *
 * No JWT, no separate signing key, no rotating session id. The lifecycle of
 * the wizard maps 1:1 to the lifecycle of the token file.
 */

export async function authenticateWizardRequest(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SETUP_COOKIE)?.value;
  if (!token) return false;
  return verifySetupToken(token);
}

export function buildSessionCookieAttributes() {
  return {
    name: SETUP_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  };
}
