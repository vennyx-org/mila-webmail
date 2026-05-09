import { NextRequest, NextResponse } from 'next/server';
import { detectSetupState } from '@/lib/setup/state';
import { authenticateWizardRequest } from '@/lib/setup/session';
import { configManager } from '@/lib/admin/config-manager';
import { CONFIG_ENV_MAP } from '@/lib/admin/types';
import { parseJmapServers } from '@/lib/admin/jmap-servers';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * Mapping of wizard-friendly step keys to the config keys they update. Each
 * step's PATCH validates against this allowlist so a compromised wizard
 * client can't slip in arbitrary config keys.
 */
const STEP_KEYS: Record<string, string[]> = {
  server: [
    'appName',
    'jmapServerUrl',
    'stalwartFeaturesEnabled',
    'jmapServers',
    'jmapServerAutoPickByDomain',
  ],
  auth: [
    'oauthEnabled',
    'oauthOnly',
    'oauthClientId',
    'oauthClientSecret',
    'oauthIssuerUrl',
  ],
  security: ['sessionSecret', 'settingsSyncEnabled'],
  logging: ['logFormat', 'logLevel'],
  branding: [
    'faviconUrl',
    'appLogoLightUrl',
    'appLogoDarkUrl',
    'loginLogoLightUrl',
    'loginLogoDarkUrl',
    'loginCompanyName',
    'loginImprintUrl',
    'loginPrivacyPolicyUrl',
    'loginWebsiteUrl',
  ],
};

/**
 * POST /api/setup/step
 * Body: { step: 'server' | 'auth' | ..., values: Record<string, unknown> }
 *
 * Persists partial config under the admin override (config.json). Each
 * step's allowed keys are restricted by STEP_KEYS so the client can only
 * touch what the corresponding screen owns.
 */
export async function POST(request: NextRequest) {
  if (detectSetupState() !== 'bootstrap') {
    return NextResponse.json({ error: 'Setup is not active' }, { status: 404 });
  }
  if (!(await authenticateWizardRequest())) {
    return NextResponse.json({ error: 'Wizard session required' }, { status: 401 });
  }

  let body: { step?: unknown; values?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const step = typeof body?.step === 'string' ? body.step : '';
  const values = body?.values;
  const allowedKeys = STEP_KEYS[step];
  if (!allowedKeys) {
    return NextResponse.json({ error: `Unknown step: ${step}` }, { status: 400 });
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return NextResponse.json({ error: 'values must be an object' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (!allowedKeys.includes(key)) {
      return NextResponse.json({ error: `Key not allowed in step ${step}: ${key}` }, { status: 400 });
    }
    if (!(key in CONFIG_ENV_MAP)) {
      return NextResponse.json({ error: `Unknown config key: ${key}` }, { status: 400 });
    }
    if (key === 'jmapServers') {
      // Sanitize: drop entries with bad ids, dup ids, or non-HTTP URLs
      // before they're persisted. Mirrors the admin config PATCH route.
      if (value != null && !Array.isArray(value)) {
        return NextResponse.json({ error: 'jmapServers must be an array' }, { status: 400 });
      }
      const sanitized = parseJmapServers(value);
      const incomingCount = Array.isArray(value) ? value.length : 0;
      if (sanitized.length !== incomingCount) {
        return NextResponse.json(
          { error: `One or more jmapServers entries were invalid (kept ${sanitized.length}/${incomingCount})` },
          { status: 400 },
        );
      }
      updates[key] = sanitized;
      continue;
    }
    updates[key] = value;
  }

  try {
    await configManager.ensureLoaded();
    await configManager.setAdminConfig(updates);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Wizard step save failed', {
      step,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Failed to save step' }, { status: 500 });
  }
}
