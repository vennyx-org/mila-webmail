import { NextRequest, NextResponse } from 'next/server';
import { detectSetupState } from '@/lib/setup/state';
import { authenticateWizardRequest } from '@/lib/setup/session';

export const dynamic = 'force-dynamic';

const JMAP_ENDPOINTS = ['/.well-known/jmap', '/jmap/session', '/jmap'];
const FETCH_TIMEOUT_MS = 5000;

/**
 * POST /api/setup/test-jmap - server-side probe of a JMAP server. Mirrors
 * the check_jmap_server() helper in setup.sh: we hit a few common session
 * endpoints and look for capability strings to confirm the URL is actually
 * a JMAP server (vs. a generic HTTP 200 page).
 *
 * Body: { url: string }
 */
export async function POST(request: NextRequest) {
  if (detectSetupState() !== 'bootstrap') {
    return NextResponse.json({ error: 'Setup is not active' }, { status: 404 });
  }
  if (!(await authenticateWizardRequest())) {
    return NextResponse.json({ error: 'Wizard session required' }, { status: 401 });
  }

  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const raw = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!raw) {
    return NextResponse.json({ error: 'url required' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return NextResponse.json({ status: 'invalid_url', message: 'URL is not well-formed' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return NextResponse.json({ status: 'invalid_url', message: 'URL must use http or https' });
  }

  const base = raw.replace(/\/+$/, '');

  for (const endpoint of JMAP_ENDPOINTS) {
    const target = base + endpoint;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(target, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) continue;
      const text = await res.text();
      if (looksLikeJmapSession(text)) {
        return NextResponse.json({
          status: 'jmap_detected',
          endpoint,
          httpStatus: res.status,
        });
      }
    } catch {
      // Try the next endpoint; we'll fall through to a final reachability
      // check below if none match.
    }
  }

  // No JMAP session found. Was the server even reachable?
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(base, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return NextResponse.json({
      status: 'reachable_no_jmap',
      httpStatus: res.status,
      message:
        'Server responded but no JMAP session was found at standard paths. ' +
        'This is OK if a reverse proxy routes JMAP separately.',
    });
  } catch (error) {
    return NextResponse.json({
      status: 'unreachable',
      message: error instanceof Error ? error.message : 'Connection failed',
    });
  }
}

function looksLikeJmapSession(body: string): boolean {
  return /"capabilities"|"apiUrl"|"downloadUrl"|"urn:ietf:params:jmap/i.test(body);
}
