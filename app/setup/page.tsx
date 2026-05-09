'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/browser-navigation';

type State = 'bootstrap' | 'configured' | 'env-managed';

interface StatusResponse {
  state: State;
  authenticated: boolean;
  readOnly: boolean;
  partialConfig: Record<string, unknown> | null;
}

interface JmapServerRow {
  id: string;
  label: string;
  url: string;
  /** comma-separated, parsed before save */
  domains: string;
}

interface WizardConfig {
  // Server
  appName: string;
  jmapServerUrl: string;
  stalwartFeaturesEnabled: boolean;
  jmapServers: JmapServerRow[];
  jmapServerAutoPickByDomain: boolean;
  // Auth
  oauthEnabled: boolean;
  oauthOnly: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthIssuerUrl: string;
  // Security
  sessionSecret: string;
  settingsSyncEnabled: boolean;
  // Logging
  logFormat: 'text' | 'json';
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  // Branding
  faviconUrl: string;
  appLogoLightUrl: string;
  appLogoDarkUrl: string;
  loginLogoLightUrl: string;
  loginLogoDarkUrl: string;
  loginCompanyName: string;
  loginImprintUrl: string;
  loginPrivacyPolicyUrl: string;
  loginWebsiteUrl: string;
}

const EMPTY_CONFIG: WizardConfig = {
  appName: 'Bulwark Webmail',
  jmapServerUrl: '',
  stalwartFeaturesEnabled: true,
  jmapServers: [],
  jmapServerAutoPickByDomain: false,
  oauthEnabled: false,
  oauthOnly: false,
  oauthClientId: '',
  oauthClientSecret: '',
  oauthIssuerUrl: '',
  sessionSecret: '',
  settingsSyncEnabled: true,
  logFormat: 'text',
  logLevel: 'info',
  faviconUrl: '',
  appLogoLightUrl: '',
  appLogoDarkUrl: '',
  loginLogoLightUrl: '',
  loginLogoDarkUrl: '',
  loginCompanyName: '',
  loginImprintUrl: '',
  loginPrivacyPolicyUrl: '',
  loginWebsiteUrl: '',
};

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'server', label: 'Server' },
  { id: 'auth', label: 'Auth' },
  { id: 'security', label: 'Security' },
  { id: 'logging', label: 'Logging' },
  { id: 'branding', label: 'Branding' },
  { id: 'review', label: 'Review' },
] as const;

export default function SetupWizardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [bootstrapping, setBootstrapping] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<State>('bootstrap');
  const [authenticated, setAuthenticated] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [config, setConfig] = useState<WizardConfig>(EMPTY_CONFIG);
  const [stepIndex, setStepIndex] = useState(0);
  const [completed, setCompleted] = useState(false);

  // ─── Initial status load ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/setup/status', { cache: 'no-store' });
        const data = (await res.json()) as StatusResponse;
        if (cancelled) return;

        setState(data.state);
        setReadOnly(data.readOnly);

        if (data.state === 'configured' || data.state === 'env-managed') {
          // Wizard not active - bounce to login. Middleware will 404 us
          // before we get here in practice, but defensive.
          router.replace('/');
          return;
        }

        setAuthenticated(data.authenticated);
        if (data.partialConfig) {
          setConfig((prev) => mergePartial(prev, data.partialConfig!));
          // If auth is OK and we already have a JMAP URL persisted, jump
          // ahead to the next unfilled step.
          if (data.authenticated && data.partialConfig.jmapServerUrl) {
            setStepIndex(2);
          } else if (data.authenticated) {
            setStepIndex(1);
          }
        }
      } catch (e) {
        if (!cancelled) setError(humanError(e));
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // ─── Token submit (welcome step) ────────────────────────────────────────
  async function submitToken(token: string) {
    setError(null);
    const res = await apiFetch('/api/setup/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Token rejected (HTTP ${res.status})`);
    }
    setAuthenticated(true);
    setStepIndex(1);
  }

  // ─── Step persistence ───────────────────────────────────────────────────
  async function saveStep(step: string, values: Record<string, unknown>) {
    const res = await apiFetch('/api/setup/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step, values }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Step save failed (HTTP ${res.status})`);
    }
  }

  // ─── Render shell ───────────────────────────────────────────────────────
  if (bootstrapping) {
    return <CenteredCard><p className="text-muted-foreground">Loading…</p></CenteredCard>;
  }

  if (completed) {
    return <CompletedScreen />;
  }

  if (state !== 'bootstrap') {
    return <AlreadyConfiguredScreen />;
  }

  if (readOnly) {
    return (
      <CenteredCard>
        <h1 className="text-lg font-semibold">Configuration is read-only</h1>
        <p className="text-sm text-muted-foreground mt-2">
          The config volume is mounted read-only or <code className="font-mono text-xs">ADMIN_CONFIG_READONLY</code> is set.
          Remount it read-write or unset that variable, then restart the container.
        </p>
      </CenteredCard>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-2xl">
        <Header />
        <ProgressBar stepIndex={stepIndex} />

        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

          {!authenticated ? (
            <WelcomeStep
              tokenFromUrl={searchParams.get('token') ?? ''}
              onSubmit={async (t) => {
                try {
                  await submitToken(t);
                } catch (e) {
                  setError(humanError(e));
                }
              }}
            />
          ) : (
            <StepContent
              stepIndex={stepIndex}
              config={config}
              setConfig={setConfig}
              onNext={async (step, values) => {
                try {
                  await saveStep(step, values);
                  setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
                } catch (e) {
                  setError(humanError(e));
                }
              }}
              onBack={() => setStepIndex((i) => Math.max(i - 1, 1))}
              onFinish={() => {
                setCompleted(true);
                // Hard navigation after a beat — gives the user a moment
                // to see the success screen and works around any router
                // edge cases that swallow client-side replaces after the
                // setupComplete flag flips.
                setTimeout(() => {
                  window.location.assign('/admin/login');
                }, 1500);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Layout helpers ───────────────────────────────────────────────────────

function Header() {
  return (
    <div className="text-center mb-6">
      <h1 className="text-2xl font-semibold">Bulwark Webmail Setup</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Configure your webmail instance from the browser.
      </p>
    </div>
  );
}

function ProgressBar({ stepIndex }: { stepIndex: number }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-1.5 text-xs">
        {STEPS.map((step, i) => (
          <div key={step.id} className="flex-1">
            <div
              className={
                'h-1 rounded-full transition-colors ' +
                (i < stepIndex
                  ? 'bg-primary'
                  : i === stepIndex
                    ? 'bg-primary/60'
                    : 'bg-muted')
              }
            />
            <div
              className={
                'mt-1.5 text-center ' +
                (i === stepIndex
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground')
              }
            >
              {step.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompletedScreen() {
  return (
    <CenteredCard>
      <div className="text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6 text-primary"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold">You&apos;re all set!</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Bulwark Webmail is configured and ready to use.
        </p>
      </div>
      <div className="mt-6 space-y-2">
        <a
          href="/admin/login"
          className="block w-full rounded-md bg-primary text-primary-foreground text-center px-4 py-2.5 text-sm font-medium hover:bg-primary/90"
        >
          Sign in to admin dashboard
        </a>
        <a
          href="/"
          className="block w-full rounded-md border border-border text-center px-4 py-2.5 text-sm font-medium hover:bg-muted"
        >
          Open webmail login
        </a>
      </div>
      <p className="text-xs text-muted-foreground text-center mt-4">
        Taking you to the admin dashboard…
      </p>
    </CenteredCard>
  );
}

function AlreadyConfiguredScreen() {
  return (
    <CenteredCard>
      <div className="text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6 text-primary"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold">Setup is already complete</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Bulwark Webmail is configured. Sign in to continue.
        </p>
      </div>
      <div className="mt-6 space-y-2">
        <a
          href="/admin/login"
          className="block w-full rounded-md bg-primary text-primary-foreground text-center px-4 py-2.5 text-sm font-medium hover:bg-primary/90"
        >
          Sign in to admin dashboard
        </a>
        <a
          href="/"
          className="block w-full rounded-md border border-border text-center px-4 py-2.5 text-sm font-medium hover:bg-muted"
        >
          Open webmail login
        </a>
      </div>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="bg-card border border-border rounded-lg p-6 shadow-sm max-w-md w-full">
        {children}
      </div>
    </div>
  );
}

function ErrorBanner({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2 mb-4 flex justify-between items-start gap-2">
      <span>{error}</span>
      <button onClick={onDismiss} className="text-xs underline shrink-0" type="button">
        dismiss
      </button>
    </div>
  );
}

// ─── Welcome / token step ────────────────────────────────────────────────

function WelcomeStep({ tokenFromUrl, onSubmit }: { tokenFromUrl: string; onSubmit: (t: string) => Promise<void> }) {
  const [token, setToken] = useState(tokenFromUrl);
  const [submitting, setSubmitting] = useState(false);

  // Auto-submit if token came in via URL.
  useEffect(() => {
    if (tokenFromUrl && !submitting) {
      setSubmitting(true);
      onSubmit(tokenFromUrl).finally(() => setSubmitting(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenFromUrl]);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit(token.trim());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-4">
      <h2 className="text-lg font-semibold">Welcome</h2>
      <p className="text-sm text-muted-foreground">
        Paste the setup token printed in the container logs to continue. The token expires after 1 hour.
      </p>
      <Field label="Setup token">
        <Input value={token} onChange={(v) => setToken(v)} autoFocus required placeholder="32-byte hex token" />
      </Field>
      <PrimaryButton type="submit" disabled={submitting || !token.trim()}>
        {submitting ? 'Verifying…' : 'Continue'}
      </PrimaryButton>
    </form>
  );
}

// ─── Step router ─────────────────────────────────────────────────────────

interface StepProps {
  stepIndex: number;
  config: WizardConfig;
  setConfig: React.Dispatch<React.SetStateAction<WizardConfig>>;
  onNext: (step: string, values: Record<string, unknown>) => Promise<void>;
  onBack: () => void;
  onFinish: () => void;
}

function StepContent({ stepIndex, config, setConfig, onNext, onBack, onFinish }: StepProps) {
  switch (stepIndex) {
    case 1:
      return <ServerStep config={config} setConfig={setConfig} onNext={onNext} />;
    case 2:
      return <AuthStep config={config} setConfig={setConfig} onNext={onNext} onBack={onBack} />;
    case 3:
      return <SecurityStep config={config} setConfig={setConfig} onNext={onNext} onBack={onBack} />;
    case 4:
      return <LoggingStep config={config} setConfig={setConfig} onNext={onNext} onBack={onBack} />;
    case 5:
      return <BrandingStep config={config} setConfig={setConfig} onNext={onNext} onBack={onBack} />;
    case 6:
      return <ReviewStep config={config} onBack={onBack} onFinish={onFinish} />;
    default:
      return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
}

// ─── Server step ─────────────────────────────────────────────────────────

function ServerStep({ config, setConfig, onNext }: Pick<StepProps, 'config' | 'setConfig' | 'onNext'>) {
  const [submitting, setSubmitting] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  async function testJmap() {
    setProbe(null);
    setProbing(true);
    try {
      const res = await apiFetch('/api/setup/test-jmap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: config.jmapServerUrl }),
      });
      const data = await res.json();
      if (data.status === 'jmap_detected') {
        setProbe(`JMAP server confirmed at ${data.endpoint}`);
      } else if (data.status === 'reachable_no_jmap') {
        setProbe(`Server reachable (HTTP ${data.httpStatus}) but no JMAP session found at standard paths.`);
      } else {
        setProbe(data.message ?? 'Could not reach server.');
      }
    } catch (e) {
      setProbe(humanError(e));
    } finally {
      setProbing(false);
    }
  }

  const [showAdditional, setShowAdditional] = useState(config.jmapServers.length > 0);

  function updateRow(index: number, patch: Partial<JmapServerRow>) {
    setConfig({
      ...config,
      jmapServers: config.jmapServers.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  }

  function addRow() {
    setConfig({
      ...config,
      jmapServers: [...config.jmapServers, { id: '', label: '', url: '', domains: '' }],
    });
    setShowAdditional(true);
  }

  function removeRow(index: number) {
    setConfig({
      ...config,
      jmapServers: config.jmapServers.filter((_, i) => i !== index),
    });
  }

  // Validate the multi-server rows: each must have a unique id matching the
  // schema, a usable URL, and no collision with the primary server.
  const rowErrors: string[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < config.jmapServers.length; i++) {
    const r = config.jmapServers[i];
    const id = r.id.trim();
    if (!id) {
      rowErrors.push(`Server #${i + 1}: id is required`);
    } else if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
      rowErrors.push(`Server #${i + 1}: id must be alphanumeric (with - or _), starting with a letter or digit`);
    } else if (seenIds.has(id)) {
      rowErrors.push(`Server #${i + 1}: id "${id}" is duplicated`);
    } else {
      seenIds.add(id);
    }
    const url = r.url.trim();
    if (!url) {
      rowErrors.push(`Server #${i + 1}: url is required`);
    } else if (!/^https?:\/\//i.test(url)) {
      rowErrors.push(`Server #${i + 1}: url must start with http:// or https://`);
    }
  }
  const hasRowErrors = rowErrors.length > 0;

  async function handle(e: FormEvent) {
    e.preventDefault();
    if (hasRowErrors) return;
    setSubmitting(true);
    try {
      await onNext('server', {
        appName: config.appName,
        jmapServerUrl: config.jmapServerUrl,
        stalwartFeaturesEnabled: config.stalwartFeaturesEnabled,
        // The API route runs parseJmapServers on this; we pre-canonicalize
        // here so the round-trip is clean.
        jmapServers: rowsToCanonical(config.jmapServers),
        jmapServerAutoPickByDomain: config.jmapServerAutoPickByDomain,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader title="Server" subtitle="Where your mail lives." />
      <Field label="Application name">
        <Input value={config.appName} onChange={(v) => setConfig({ ...config, appName: v })} required />
      </Field>
      <Field label="JMAP server URL" hint="The default server users connect to. Example: https://mail.example.com">
        <div className="flex gap-2">
          <Input
            value={config.jmapServerUrl}
            onChange={(v) => setConfig({ ...config, jmapServerUrl: v })}
            required
            placeholder="https://"
            type="url"
          />
          <button
            type="button"
            onClick={testJmap}
            disabled={!config.jmapServerUrl || probing}
            className="px-3 py-2 text-sm border border-border rounded-md hover:bg-muted disabled:opacity-50"
          >
            {probing ? 'Testing…' : 'Test'}
          </button>
        </div>
        {probe && <p className="text-xs text-muted-foreground mt-1.5">{probe}</p>}
      </Field>

      {/* Additional servers (optional) */}
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">Additional JMAP servers</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Optional. Surface multiple servers in the login dropdown - useful for hosts running several Stalwart instances.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdditional((v) => !v)}
            className="text-xs underline text-muted-foreground hover:text-foreground shrink-0"
          >
            {showAdditional ? 'Hide' : config.jmapServers.length > 0 ? `Show (${config.jmapServers.length})` : 'Add'}
          </button>
        </div>

        {showAdditional && (
          <div className="mt-3 space-y-3">
            {config.jmapServers.map((row, i) => (
              <div key={i} className="rounded-md border border-border bg-background p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Server #{i + 1}</span>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="text-xs text-destructive hover:underline"
                  >
                    Remove
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="ID" hint="Unique slug, e.g. eu-1">
                    <Input value={row.id} onChange={(v) => updateRow(i, { id: v })} placeholder="eu-1" required />
                  </Field>
                  <Field label="Label" hint="Shown to users">
                    <Input value={row.label} onChange={(v) => updateRow(i, { label: v })} placeholder="Europe (primary)" />
                  </Field>
                </div>
                <Field label="URL">
                  <Input value={row.url} onChange={(v) => updateRow(i, { url: v })} placeholder="https://" type="url" required />
                </Field>
                <Field label="Domains" hint="Comma-separated. Used to auto-pick this server by email domain at login.">
                  <Input value={row.domains} onChange={(v) => updateRow(i, { domains: v })} placeholder="example.com, mail.example.com" />
                </Field>
              </div>
            ))}

            <button
              type="button"
              onClick={addRow}
              className="w-full px-3 py-2 text-sm border border-dashed border-border rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              + Add server
            </button>

            {config.jmapServers.length > 0 && (
              <Toggle
                checked={config.jmapServerAutoPickByDomain}
                onChange={(v) => setConfig({ ...config, jmapServerAutoPickByDomain: v })}
                label="Auto-pick server by email domain"
                hint="When a user types their email, automatically select the matching server from the list above."
              />
            )}

            {hasRowErrors && (
              <ul className="text-xs text-destructive list-disc pl-5 space-y-0.5">
                {rowErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <Toggle
        checked={config.stalwartFeaturesEnabled}
        onChange={(v) => setConfig({ ...config, stalwartFeaturesEnabled: v })}
        label="Enable Stalwart-specific features"
        hint="Adds password change and Sieve filter management. Safe to enable on non-Stalwart servers."
      />

      <Footer>
        <PrimaryButton type="submit" disabled={submitting || !config.jmapServerUrl || hasRowErrors}>
          {submitting ? 'Saving…' : 'Next'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Auth step ───────────────────────────────────────────────────────────

function AuthStep({ config, setConfig, onNext, onBack }: Pick<StepProps, 'config' | 'setConfig' | 'onNext' | 'onBack'>) {
  const [submitting, setSubmitting] = useState(false);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const values: Partial<WizardConfig> = { oauthEnabled: config.oauthEnabled };
      if (config.oauthEnabled) {
        values.oauthOnly = config.oauthOnly;
        values.oauthClientId = config.oauthClientId;
        values.oauthIssuerUrl = config.oauthIssuerUrl;
        if (config.oauthClientSecret) {
          values.oauthClientSecret = config.oauthClientSecret;
        }
      }
      await onNext('auth', values);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader title="Authentication" subtitle="Basic auth is always available. OAuth/OIDC is optional." />
      <Toggle
        checked={config.oauthEnabled}
        onChange={(v) => setConfig({ ...config, oauthEnabled: v })}
        label="Enable OAuth2 / OpenID Connect"
      />
      {config.oauthEnabled && (
        <>
          <Toggle
            checked={config.oauthOnly}
            onChange={(v) => setConfig({ ...config, oauthOnly: v })}
            label="OAuth-only mode (hide password form)"
          />
          <Field label="OAuth Client ID">
            <Input value={config.oauthClientId} onChange={(v) => setConfig({ ...config, oauthClientId: v })} required />
          </Field>
          <Field label="OAuth Client Secret" hint="Leave blank for public clients using PKCE only.">
            <Input
              value={config.oauthClientSecret}
              onChange={(v) => setConfig({ ...config, oauthClientSecret: v })}
              type="password"
              placeholder="paste secret"
            />
          </Field>
          <Field label="OAuth Issuer URL" hint="For external IdPs (Keycloak, Authentik, Entra ID, etc.).">
            <Input value={config.oauthIssuerUrl} onChange={(v) => setConfig({ ...config, oauthIssuerUrl: v })} type="url" />
          </Field>
        </>
      )}
      <Footer>
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Next'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Security step ───────────────────────────────────────────────────────

function generateSessionSecret(): string {
  // 32 random bytes, base64-encoded - same shape as `openssl rand -base64 32`.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function SecurityStep({ config, setConfig, onNext, onBack }: Pick<StepProps, 'config' | 'setConfig' | 'onNext' | 'onBack'>) {
  const [submitting, setSubmitting] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [customize, setCustomize] = useState(false);

  // Auto-generate on first render so the operator doesn't have to click a
  // button for the recommended path. They can still regenerate or paste
  // their own via the "Customize" toggle.
  useEffect(() => {
    if (!config.sessionSecret) {
      setConfig((prev) => ({ ...prev, sessionSecret: generateSessionSecret() }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const values: Partial<WizardConfig> = {
        settingsSyncEnabled: config.settingsSyncEnabled,
      };
      if (config.sessionSecret) values.sessionSecret = config.sessionSecret;
      await onNext('security', values);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader
        title="Security & Sessions"
        subtitle='Session secret unlocks "Remember me" and settings sync.'
      />

      <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">Session secret generated</span>
          <button
            type="button"
            onClick={() => setCustomize((v) => !v)}
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            {customize ? 'Hide' : 'Customize'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          A 32-byte secret was created for you. You only need to change this if you have a specific reason.
        </p>
      </div>

      {customize && (
        <Field label="Session secret" hint="Paste your own value or click regenerate.">
          <div className="flex gap-2">
            <Input
              value={config.sessionSecret}
              onChange={(v) => setConfig({ ...config, sessionSecret: v })}
              type={reveal ? 'text' : 'password'}
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className="px-3 py-2 text-sm border border-border rounded-md hover:bg-muted"
            >
              {reveal ? 'Hide' : 'Show'}
            </button>
            <button
              type="button"
              onClick={() => setConfig({ ...config, sessionSecret: generateSessionSecret() })}
              className="px-3 py-2 text-sm border border-border rounded-md hover:bg-muted"
            >
              Regenerate
            </button>
          </div>
        </Field>
      )}

      <Toggle
        checked={config.settingsSyncEnabled}
        onChange={(v) => setConfig({ ...config, settingsSyncEnabled: v })}
        label="Sync user settings across devices"
        hint="Stores user preferences server-side, encrypted with the session secret."
        disabled={!config.sessionSecret}
      />
      <Footer>
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Next'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Logging step ────────────────────────────────────────────────────────

function LoggingStep({ config, setConfig, onNext, onBack }: Pick<StepProps, 'config' | 'setConfig' | 'onNext' | 'onBack'>) {
  const [submitting, setSubmitting] = useState(false);
  async function handle(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onNext('logging', { logFormat: config.logFormat, logLevel: config.logLevel });
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader title="Logging" subtitle="Format and verbosity for the application logs." />
      <Field label="Format">
        <Select
          value={config.logFormat}
          onChange={(v) => setConfig({ ...config, logFormat: v as 'text' | 'json' })}
          options={[
            { value: 'text', label: 'text - colored, human-readable' },
            { value: 'json', label: 'json - structured, for log aggregation' },
          ]}
        />
      </Field>
      <Field label="Level">
        <Select
          value={config.logLevel}
          onChange={(v) => setConfig({ ...config, logLevel: v as WizardConfig['logLevel'] })}
          options={[
            { value: 'error', label: 'error' },
            { value: 'warn', label: 'warn' },
            { value: 'info', label: 'info (recommended)' },
            { value: 'debug', label: 'debug' },
          ]}
        />
      </Field>
      <Footer>
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Next'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Branding step ───────────────────────────────────────────────────────

function BrandingStep({ config, setConfig, onNext, onBack }: Pick<StepProps, 'config' | 'setConfig' | 'onNext' | 'onBack'>) {
  const [submitting, setSubmitting] = useState(false);
  async function handle(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      // Only send fields the operator actually filled in. Saving an empty
      // string would create an admin override that shadows the system
      // default — a blank "Login logo" field would suppress the default
      // Bulwark logo on the login page, which is never what we want from
      // the wizard.
      const allFields = {
        faviconUrl: config.faviconUrl,
        appLogoLightUrl: config.appLogoLightUrl,
        appLogoDarkUrl: config.appLogoDarkUrl,
        loginLogoLightUrl: config.loginLogoLightUrl,
        loginLogoDarkUrl: config.loginLogoDarkUrl,
        loginCompanyName: config.loginCompanyName,
        loginImprintUrl: config.loginImprintUrl,
        loginPrivacyPolicyUrl: config.loginPrivacyPolicyUrl,
        loginWebsiteUrl: config.loginWebsiteUrl,
      };
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(allFields)) {
        if (v.trim() !== '') values[k] = v.trim();
      }
      await onNext('branding', values);
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader title="Branding" subtitle="All fields optional. Skip any field to use defaults." />
      <Field label="Company / organization name">
        <Input value={config.loginCompanyName} onChange={(v) => setConfig({ ...config, loginCompanyName: v })} />
      </Field>
      <Field label="Favicon URL" hint="SVG recommended. Absolute URL or path under /public.">
        <Input value={config.faviconUrl} onChange={(v) => setConfig({ ...config, faviconUrl: v })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Login logo (light)">
          <Input value={config.loginLogoLightUrl} onChange={(v) => setConfig({ ...config, loginLogoLightUrl: v })} />
        </Field>
        <Field label="Login logo (dark)">
          <Input value={config.loginLogoDarkUrl} onChange={(v) => setConfig({ ...config, loginLogoDarkUrl: v })} />
        </Field>
        <Field label="Sidebar logo (light)">
          <Input value={config.appLogoLightUrl} onChange={(v) => setConfig({ ...config, appLogoLightUrl: v })} />
        </Field>
        <Field label="Sidebar logo (dark)">
          <Input value={config.appLogoDarkUrl} onChange={(v) => setConfig({ ...config, appLogoDarkUrl: v })} />
        </Field>
      </div>
      <Field label="Website URL">
        <Input value={config.loginWebsiteUrl} onChange={(v) => setConfig({ ...config, loginWebsiteUrl: v })} type="url" />
      </Field>
      <Field label="Imprint URL">
        <Input value={config.loginImprintUrl} onChange={(v) => setConfig({ ...config, loginImprintUrl: v })} type="url" />
      </Field>
      <Field label="Privacy policy URL">
        <Input value={config.loginPrivacyPolicyUrl} onChange={(v) => setConfig({ ...config, loginPrivacyPolicyUrl: v })} type="url" />
      </Field>
      <Footer>
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Next'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Review / finish step ─────────────────────────────────────────────────

function ReviewStep({ config, onBack, onFinish }: { config: WizardConfig; onBack: () => void; onFinish: () => void }) {
  const [adminPassword, setAdminPassword] = useState('');
  const [adminConfirm, setAdminConfirm] = useState('');
  const [lockConfig, setLockConfig] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (adminPassword.length < 8) {
      setLocalError('Admin password must be at least 8 characters.');
      return;
    }
    if (adminPassword !== adminConfirm) {
      setLocalError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/setup/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPassword, lockConfig }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLocalError(data.error ?? `Finish failed (HTTP ${res.status})`);
        return;
      }
      onFinish();
    } catch (e) {
      setLocalError(humanError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader title="Review & Finish" subtitle="Set the admin password, then apply." />
      <div className="bg-muted/50 rounded-md p-3 text-xs space-y-1">
        <Row label="App name" value={config.appName} />
        <Row label="JMAP server" value={config.jmapServerUrl} />
        {config.jmapServers.length > 0 && (
          <Row
            label="Additional servers"
            value={
              config.jmapServers.map((s) => s.id).join(', ') +
              (config.jmapServerAutoPickByDomain ? ' (auto-pick by domain)' : '')
            }
          />
        )}
        <Row label="Stalwart features" value={config.stalwartFeaturesEnabled ? 'on' : 'off'} />
        <Row label="OAuth" value={config.oauthEnabled ? (config.oauthOnly ? 'enabled (OAuth-only)' : 'enabled') : 'off'} />
        <Row label="Session secret" value={config.sessionSecret ? 'set' : 'not set'} />
        <Row label="Settings sync" value={config.settingsSyncEnabled ? 'on' : 'off'} />
        <Row label="Logging" value={`${config.logFormat} / ${config.logLevel}`} />
        <Row label="Branding" value={hasAnyBranding(config) ? 'customized' : 'defaults'} />
      </div>

      <Field label="Admin password" hint="Used to log into the admin dashboard at /admin.">
        <Input value={adminPassword} onChange={setAdminPassword} type="password" required />
      </Field>
      <Field label="Confirm admin password">
        <Input value={adminConfirm} onChange={setAdminConfirm} type="password" required />
      </Field>

      <Toggle
        checked={lockConfig}
        onChange={setLockConfig}
        label="Lock configuration after setup"
        hint="Drops a marker file. After this finishes, you can remount the config volume :ro and the app will refuse further config writes. Audit logs and login state stay writable in the state volume."
      />

      {localError && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{localError}</p>
      )}

      <Footer>
        <SecondaryButton onClick={onBack} disabled={submitting}>Back</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Applying…' : 'Apply & Finish'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Atoms ────────────────────────────────────────────────────────────────

function StepHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="border-b border-border pb-3 mb-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

function Input({
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      autoFocus={autoFocus}
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={'flex items-start gap-3 cursor-pointer ' + (disabled ? 'opacity-50 cursor-not-allowed' : '')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4"
      />
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
    </label>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 pt-3 border-t border-border mt-4">{children}</div>;
}

function PrimaryButton({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium truncate text-right">{value}</span>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mergePartial(prev: WizardConfig, partial: Record<string, unknown>): WizardConfig {
  const next: WizardConfig = { ...prev };
  for (const key of Object.keys(prev) as (keyof WizardConfig)[]) {
    const incoming = partial[key];
    if (incoming === undefined) continue;
    if (key === 'jmapServers') {
      // Server stores canonical shape; wizard form uses csv domains string.
      next.jmapServers = canonicalToRows(incoming);
      continue;
    }
    if (typeof incoming === typeof prev[key] || prev[key] === '' || prev[key] === false) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (next as any)[key] = incoming;
    }
  }
  return next;
}

function canonicalToRows(value: unknown): JmapServerRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): JmapServerRow | null => {
      if (!item || typeof item !== 'object') return null;
      const e = item as Record<string, unknown>;
      const id = typeof e.id === 'string' ? e.id : '';
      const label = typeof e.label === 'string' ? e.label : '';
      const url = typeof e.url === 'string' ? e.url : '';
      const domains = Array.isArray(e.domains)
        ? (e.domains as unknown[])
            .filter((d): d is string => typeof d === 'string')
            .join(', ')
        : '';
      if (!id || !url) return null;
      return { id, label, url, domains };
    })
    .filter((r): r is JmapServerRow => r !== null);
}

function rowsToCanonical(rows: JmapServerRow[]) {
  return rows
    .map((r) => {
      const id = r.id.trim();
      const url = r.url.trim();
      if (!id || !url) return null;
      const domains = r.domains
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
      return {
        id,
        label: r.label.trim() || id,
        url,
        ...(domains.length > 0 ? { domains } : {}),
      };
    })
    .filter((e): e is { id: string; label: string; url: string; domains?: string[] } => e !== null);
}

function hasAnyBranding(c: WizardConfig): boolean {
  return Boolean(
    c.loginCompanyName ||
      c.faviconUrl ||
      c.appLogoLightUrl ||
      c.appLogoDarkUrl ||
      c.loginLogoLightUrl ||
      c.loginLogoDarkUrl ||
      c.loginWebsiteUrl ||
      c.loginImprintUrl ||
      c.loginPrivacyPolicyUrl,
  );
}

function humanError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown error';
}
