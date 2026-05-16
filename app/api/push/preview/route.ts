import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import {
  getStalwartCredentials,
  type StalwartCredentials,
} from '@/lib/stalwart/credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ResolvedTarget {
  authHeader: string;
  apiUrl: string;
  accountId: string;
}

// When the SW passes ?accountId=, we need the slot whose JMAP session owns
// that account - not just "the first signed-in slot", which is what
// getStalwartCredentials() defaults to. Probe each candidate's session in
// parallel and return the first match.
async function resolveTargetForAccount(accountId: string): Promise<ResolvedTarget | null> {
  const cookieStore = await cookies();
  const probes: Promise<ResolvedTarget | null>[] = [];
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const ctx = readStalwartAuthContextFromStore(cookieStore, slot);
    if (!ctx) continue;
    const serverUrl = ctx.serverUrl.replace(/\/+$/, '');
    probes.push(
      (async () => {
        try {
          const res = await fetch(`${serverUrl}/.well-known/jmap`, {
            headers: { Authorization: ctx.authHeader },
          });
          if (!res.ok) return null;
          const session = (await res.json()) as {
            apiUrl?: string;
            primaryAccounts?: Record<string, string>;
          };
          const mailAccountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
          if (!session.apiUrl || !mailAccountId) return null;
          if (mailAccountId !== accountId) return null;
          return { authHeader: ctx.authHeader, apiUrl: session.apiUrl, accountId: mailAccountId };
        } catch {
          return null;
        }
      })(),
    );
  }
  const results = await Promise.all(probes);
  return results.find((r): r is ResolvedTarget => r !== null) ?? null;
}

async function resolveDefaultTarget(creds: StalwartCredentials): Promise<ResolvedTarget | null> {
  const sessionRes = await fetch(`${creds.serverUrl}/.well-known/jmap`, {
    headers: { Authorization: creds.authHeader },
  });
  if (!sessionRes.ok) return null;
  const session = (await sessionRes.json()) as {
    apiUrl?: string;
    primaryAccounts?: Record<string, string>;
  };
  const apiUrl = session.apiUrl;
  const accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (!apiUrl || !accountId) return null;
  return { authHeader: creds.authHeader, apiUrl, accountId };
}

/**
 * GET /api/push/preview
 *
 * Called from the service worker when a Web Push wake-up arrives. Fetches the
 * latest unread email so the SW can build an enriched system notification
 * (sender, subject, avatar) without ever exposing JMAP credentials to the
 * SW context.
 *
 * The relay's push payload is intentionally minimal (just a state-change
 * ping), so this is what makes "From: Alice / Subject: …" appear instead of
 * a generic "New mail" string.
 */
export async function GET(request: NextRequest) {
  try {
    // SW passes ?accountId=<jmap-account-id> derived from the push payload's
    // StateChange so multi-account browsers fetch from the right slot. Older
    // clients (and the manual /api/push/preview probe) omit it and fall back
    // to the first signed-in slot.
    const requestedAccountId = request.nextUrl.searchParams.get('accountId');

    let target: ResolvedTarget | null = null;
    let authHeader: string;
    if (requestedAccountId) {
      target = await resolveTargetForAccount(requestedAccountId);
      if (!target) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      }
      authHeader = target.authHeader;
    } else {
      const creds = await getStalwartCredentials(request);
      if (!creds) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      }
      target = await resolveDefaultTarget(creds);
      if (!target) {
        return NextResponse.json({ error: 'JMAP session failed' }, { status: 502 });
      }
      authHeader = creds.authHeader;
    }

    const { apiUrl, accountId } = target;

    const inboxRes = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [
          [
            'Mailbox/query',
            { accountId, filter: { role: 'inbox' }, limit: 1 },
            'mb',
          ],
        ],
      }),
    });

    if (!inboxRes.ok) {
      return NextResponse.json({ error: 'JMAP mailbox query failed' }, { status: 502 });
    }

    const inboxData = (await inboxRes.json()) as {
      methodResponses: [string, Record<string, unknown>, string][];
    };

    const inboxBody = inboxData.methodResponses.find(
      ([method]) => method === 'Mailbox/query',
    )?.[1] as { ids?: string[] } | undefined;

    const inboxId = inboxBody?.ids?.[0];

    if (!inboxId) {
      return NextResponse.json({
        email: null,
        unreadTotal: 0,
      }, {
        headers: {
          'Cache-Control': 'no-store',
        },
      });
    }

    // Pull the most recent unread message from the resolved Inbox mailbox.
    const requestBody = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        [
          'Email/query',
          {
            accountId,
            filter: {
              operator: 'AND',
              conditions: [
                { inMailbox: inboxId },
                { notKeyword: '$seen' },
              ],
            },
            sort: [{ property: 'receivedAt', isAscending: false }],
            limit: 1,
            calculateTotal: true,
          },
          'eq',
        ],
        [
          'Email/get',
          {
            accountId,
            '#ids': { resultOf: 'eq', name: 'Email/query', path: '/ids' },
            properties: ['id', 'threadId', 'from', 'subject', 'preview', 'receivedAt'],
          },
          'eg',
        ],
      ],
    };

    const jmapRes = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    if (!jmapRes.ok) {
      return NextResponse.json({ error: 'JMAP request failed' }, { status: 502 });
    }
    const data = (await jmapRes.json()) as {
      methodResponses: [string, Record<string, unknown>, string][];
    };

    type EmailLite = {
      id: string;
      threadId: string;
      from?: { name?: string | null; email?: string }[] | null;
      subject?: string | null;
      preview?: string | null;
      receivedAt?: string | null;
    };

    let email: EmailLite | null = null;
    let unreadTotal = 0;
    for (const [method, body] of data.methodResponses) {
      if (method === 'Email/query') {
        unreadTotal = ((body as { total?: number }).total) ?? 0;
      }
      if (method === 'Email/get') {
        const list = (body as { list?: EmailLite[] }).list ?? [];
        email = list[0] ?? null;
      }
    }

    return NextResponse.json({
      email,
      unreadTotal,
    }, {
      headers: {
        // SW already gates on its own logic - don't let push events get
        // cached and served stale.
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    // `fetch failed` from undici is too generic to debug - the real reason
    // (ENOTFOUND, ECONNREFUSED, TLS error, …) is on `error.cause`.
    const err = error as Error & { cause?: { code?: string; message?: string } };
    logger.error('push preview failed', {
      error: err?.message ?? 'Unknown error',
      causeCode: err?.cause?.code,
      causeMessage: err?.cause?.message,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
