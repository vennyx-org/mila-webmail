import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

/**
 * POST /api/account/change-password
 *
 * Changes the signed-in account's password. Two transports, chosen by config:
 *
 *  1. Default (no `PASSWORD_CHANGE_URL`): the standard Stalwart JMAP
 *     `x:AccountPassword/set` -- unchanged upstream behaviour, for a Stalwart
 *     whose principals live in its own writable (internal) directory.
 *
 *  2. External provider (`PASSWORD_CHANGE_URL` set): Stalwart is fronting a
 *     READ-ONLY authentication directory (SQL/LDAP/...) whose passwords are
 *     owned by a separate provisioning system, so `x:AccountPassword/set`
 *     would fail "Operation not allowed". Instead, POST the change to that
 *     system's HTTP endpoint. This is a generic extension point -- any
 *     deployment can point it at their own control plane; the webmail knows
 *     nothing about what's behind it.
 *
 *     Contract with `PASSWORD_CHANGE_URL`:
 *       Request  (POST, application/json):
 *         { "email": string, "currentPassword": string, "newPassword": string }
 *       Response:
 *         200            -> success
 *         401            -> current password incorrect (message forwarded)
 *         400            -> new password rejected by policy (message forwarded)
 *         anything else  -> treated as an upstream failure (502)
 *
 * Doing both server-side keeps the user's credentials in the httpOnly session
 * (the browser never sees them) and avoids any CORS coupling.
 *
 * Body: `{ accountId: string, currentPassword: string, newPassword: string }`
 * (`accountId` is only used by the default JMAP transport.)
 */
export async function POST(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { accountId, currentPassword, newPassword } = (await request.json()) as {
      accountId?: unknown;
      currentPassword?: unknown;
      newPassword?: unknown;
    };
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return NextResponse.json({ error: 'currentPassword and newPassword are required' }, { status: 400 });
    }

    const externalUrl = (process.env.PASSWORD_CHANGE_URL ?? '').trim().replace(/\/+$/, '');

    if (externalUrl) {
      const response = await fetch(externalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: creds.username, currentPassword, newPassword }),
      });

      if (response.ok) {
        return NextResponse.json({ ok: true });
      }

      let message = 'Failed to change password';
      try {
        const body = (await response.json()) as { message?: unknown; error?: unknown };
        const m = body?.message ?? body?.error;
        if (typeof m === 'string') message = m;
      } catch {
        /* ignore non-JSON error bodies */
      }
      const status = response.status === 401 || response.status === 400 ? response.status : 502;
      return NextResponse.json({ error: message }, { status });
    }

    // Default transport: Stalwart JMAP x:AccountPassword/set.
    if (typeof accountId !== 'string' || accountId.length === 0) {
      return NextResponse.json({ error: 'accountId is required' }, { status: 400 });
    }
    const jmapResponse = await fetch(`${creds.serverUrl}/jmap/`, {
      method: 'POST',
      headers: { Authorization: creds.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
        methodCalls: [['x:AccountPassword/set', { accountId, update: { singleton: { currentSecret: currentPassword, secret: newPassword } } }, '0']],
      }),
    });
    if (!jmapResponse.ok) {
      return NextResponse.json({ error: `Failed to change password (HTTP ${jmapResponse.status})` }, { status: 502 });
    }
    const data = (await jmapResponse.json()) as {
      methodResponses?: Array<[string, { notUpdated?: Record<string, { type?: string; description?: string }> }, string]>;
    };
    const setResult = data.methodResponses?.find((r) => r[0] === 'x:AccountPassword/set')?.[1];
    const failed = setResult?.notUpdated?.singleton;
    if (failed) {
      // Wrong current password (or policy rejection) comes back here at HTTP 200.
      return NextResponse.json({ error: failed.description || failed.type || 'Failed to change password' }, { status: 401 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('change-password error', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
