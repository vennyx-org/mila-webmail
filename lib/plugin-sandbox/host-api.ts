// Host-side implementations of the sandboxed plugin API. Every method gates
// on `plugin.permissions` BEFORE doing the underlying work, and only returns
// structured-cloneable data back to the iframe.

import type { InstalledPlugin, Permission } from '../plugin-types';
import { IMPLICIT_PERMISSIONS } from '../plugin-types';
import { toast as appToast } from '@/stores/toast-store';
import { useAuthStore } from '@/stores/auth-store';
import { apiFetch } from '../browser-navigation';
import { awaitDialog } from './host-dialog';

const PERM_PER_METHOD: Record<string, Permission | null> = {
  // storage is unscoped by the manifest - implicit.
  'storage.get': null,
  'storage.set': null,
  'storage.remove': null,
  'storage.keys': null,
  // toast / log don't need a permission (anyone can show a toast).
  'toast.success': null,
  'toast.error': null,
  'toast.info': null,
  'toast.warning': null,
  // http
  'http.post': 'http:post',
  'http.fetch': 'http:fetch',
  // admin
  'admin.getConfig': 'admin:config',
  'admin.getAllConfig': 'admin:config',
  'admin.setConfig': 'admin:config',
  'admin.deleteConfig': 'admin:config',
  // ui — any plugin can ask the host to render a modal or open a URL.
  'ui.confirm': null,
  'ui.alert': null,
  'ui.openExternalUrl': null,
};

function hasPermission(plugin: InstalledPlugin, perm: Permission): boolean {
  if ((IMPLICIT_PERMISSIONS as readonly string[]).includes(perm)) return true;
  if (!plugin.permissions.includes(perm)) return false;
  // Defense-in-depth: even if the manifest declares a permission, the host
  // refuses the API call unless an admin has marked the plugin as managed,
  // or the user has explicitly granted it via the consent dialog.
  if (plugin.managed) return true;
  return (plugin.grantedPermissions ?? []).includes(perm);
}

// ─── Cross-origin allow-list (mirrors lib/plugin-api.ts) ──────

function originMatchesAllowlist(url: URL, allowlist: string[]): boolean {
  if (url.protocol !== 'https:') return false;
  for (const entry of allowlist) {
    let parsed: URL;
    try { parsed = new URL(entry.replace('*.', '')); } catch { continue; }
    if (parsed.protocol !== 'https:') continue;
    const port = url.port || '';
    const expectedPort = parsed.port || '';
    if (port !== expectedPort) continue;
    if (entry.includes('*.')) {
      const suffix = '.' + parsed.hostname.toLowerCase();
      const host = url.hostname.toLowerCase();
      if (host.endsWith(suffix)) {
        const prefix = host.slice(0, host.length - suffix.length);
        if (prefix.length > 0 && !prefix.includes('.')) return true;
      }
    } else if (url.hostname.toLowerCase() === parsed.hostname.toLowerCase()) {
      return true;
    }
  }
  return false;
}

// ─── Per-plugin storage namespace ─────────────────────────────

const STORAGE_PREFIX = (pluginId: string) => `plugin:${pluginId}:`;

function storageGet(pluginId: string, key: string): unknown {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_PREFIX(pluginId) + key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function storageSet(pluginId: string, key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_PREFIX(pluginId) + key, JSON.stringify(value));
}
function storageRemove(pluginId: string, key: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_PREFIX(pluginId) + key);
}
function storageKeys(pluginId: string): string[] {
  if (typeof window === 'undefined') return [];
  const prefix = STORAGE_PREFIX(pluginId);
  const out: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k?.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}

// ─── http.post (same-origin /api/*) ───────────────────────────

/**
 * Returns true iff `path` is permitted by the plugin's `apiPostPaths`
 * allowlist. Entries are either exact paths (must equal `path`) or prefixes
 * that end with `/` (`path` must start with the entry).
 */
function isApiPostPathAllowed(path: string, allowlist: readonly string[]): boolean {
  for (const entry of allowlist) {
    if (typeof entry !== 'string' || !entry.startsWith('/api/')) continue;
    if (entry.endsWith('/')) {
      if (path === entry || path.startsWith(entry)) return true;
    } else if (path === entry) {
      return true;
    }
  }
  return false;
}

async function doHttpPost(plugin: InstalledPlugin, path: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new Error('path must start with /api/');
  }
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new Error('path must resolve to the same origin');
  }
  // Per-plugin path allow-list. Comparison is on the pathname only (query
  // strings don't widen the surface, so we ignore them here).
  const allow = plugin.apiPostPaths ?? [];
  if (allow.length === 0) {
    throw new Error(`Plugin "${plugin.id}" has no apiPostPaths declared`);
  }
  if (!isApiPostPathAllowed(url.pathname, allow)) {
    throw new Error(`Path ${url.pathname} not in plugin apiPostPaths allowlist`);
  }
  const { client } = useAuthStore.getState();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (client) {
    headers['Authorization'] = client.getAuthHeader();
    headers['X-JMAP-Username'] = client.getUsername();
  }
  const res = await fetch(url.pathname + url.search, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// ─── http.fetch (cross-origin, manifest-allowlisted) ──────────

interface PluginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | ArrayBufferView | null;
}

async function doHttpFetch(plugin: InstalledPlugin, rawUrl: string, init?: PluginFetchInit) {
  if (typeof rawUrl !== 'string') throw new Error('url must be a string');
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('url must be absolute https://'); }
  const allowlist = plugin.httpOrigins ?? [];
  if (allowlist.length === 0) {
    throw new Error(`Plugin "${plugin.id}" has no httpOrigins declared`);
  }
  if (!originMatchesAllowlist(url, allowlist)) {
    throw new Error(`Origin ${url.origin} not in plugin httpOrigins allowlist`);
  }
  const safeHeaders: Record<string, string> = {};
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers)) {
      const lower = k.toLowerCase();
      if (lower === 'cookie' || lower === 'x-jmap-username') continue;
      safeHeaders[k] = v;
    }
  }
  const res = await fetch(url.toString(), {
    method: init?.method ?? 'GET',
    headers: safeHeaders,
    body: (init?.body ?? undefined) as BodyInit | undefined,
    credentials: 'omit',
    mode: 'cors',
    redirect: 'follow',
  });
  // Sandboxed plugin can't hold a Response object across the boundary, so
  // we read the body once and return it as text + arrayBuffer (base64).
  const headers: Record<string, string> = {};
  res.headers.forEach((val, key) => { headers[key.toLowerCase()] = val; });
  const buf = await res.arrayBuffer();
  let text: string | null = null;
  try { text = new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch { text = null; }
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers,
    bodyText: text,
    bodyBytes: new Uint8Array(buf),
  };
}

// ─── admin config (same as before) ────────────────────────────

async function adminGetAll(pluginId: string): Promise<Record<string, unknown>> {
  const res = await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`);
  if (!res.ok) return {};
  return res.json();
}
async function adminGet(pluginId: string, key: string): Promise<unknown> {
  const all = await adminGetAll(pluginId);
  return all[key] ?? null;
}
async function adminSet(pluginId: string, key: string, value: unknown): Promise<void> {
  await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
}
async function adminDelete(pluginId: string, key: string): Promise<void> {
  await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

// ─── Dispatcher ──────────────────────────────────────────────

/** Resolves an api-request method against the per-plugin permissions. */
export async function dispatchApiCall(
  plugin: InstalledPlugin,
  method: string,
  args: unknown[],
): Promise<unknown> {
  // Permission gate
  const requiredPerm = PERM_PER_METHOD[method];
  if (requiredPerm !== undefined && requiredPerm !== null) {
    if (!hasPermission(plugin, requiredPerm)) {
      throw new Error(`Plugin "${plugin.id}" lacks permission "${requiredPerm}"`);
    }
  } else if (!(method in PERM_PER_METHOD)) {
    throw new Error(`Unknown API method "${method}"`);
  }

  switch (method) {
    case 'storage.get': return storageGet(plugin.id, args[0] as string);
    case 'storage.set': storageSet(plugin.id, args[0] as string, args[1]); return undefined;
    case 'storage.remove': storageRemove(plugin.id, args[0] as string); return undefined;
    case 'storage.keys': return storageKeys(plugin.id);

    case 'toast.success': appToast.success(String(args[0] ?? '')); return undefined;
    case 'toast.error':   appToast.error(String(args[0] ?? '')); return undefined;
    case 'toast.info':    appToast.info(String(args[0] ?? '')); return undefined;
    case 'toast.warning': appToast.warning(String(args[0] ?? '')); return undefined;

    case 'http.post':  return doHttpPost(plugin, args[0] as string, args[1]);
    case 'http.fetch': return doHttpFetch(plugin, args[0] as string, args[1] as PluginFetchInit | undefined);

    case 'admin.getConfig':    return adminGet(plugin.id, args[0] as string);
    case 'admin.getAllConfig': return adminGetAll(plugin.id);
    case 'admin.setConfig':    await adminSet(plugin.id, args[0] as string, args[1]); return undefined;
    case 'admin.deleteConfig': await adminDelete(plugin.id, args[0] as string); return undefined;

    case 'ui.confirm': {
      const opts = (args[0] ?? {}) as { title?: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
      return awaitDialog({
        pluginId: plugin.id,
        kind: 'confirm',
        title: String(opts.title ?? plugin.name ?? 'Confirm'),
        message: String(opts.message ?? ''),
        confirmLabel: typeof opts.confirmLabel === 'string' ? opts.confirmLabel : undefined,
        cancelLabel: typeof opts.cancelLabel === 'string' ? opts.cancelLabel : undefined,
        danger: !!opts.danger,
      });
    }
    case 'ui.alert': {
      const opts = (args[0] ?? {}) as { title?: string; message?: string; confirmLabel?: string };
      await awaitDialog({
        pluginId: plugin.id,
        kind: 'alert',
        title: String(opts.title ?? plugin.name ?? 'Notice'),
        message: String(opts.message ?? ''),
        confirmLabel: typeof opts.confirmLabel === 'string' ? opts.confirmLabel : undefined,
      });
      return undefined;
    }
    case 'ui.openExternalUrl': {
      const url = String(args[0] ?? '');
      // Only http(s) — the sandbox should not be able to navigate the host
      // anywhere internal, nor open javascript:/data:/file: schemes.
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('ui.openExternalUrl: invalid URL'); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`ui.openExternalUrl: ${parsed.protocol} not allowed`);
      }
      // Always open in a new tab; plugins must not be able to navigate the
      // host window (_self/_top/_parent) to an attacker-controlled origin.
      window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
      return undefined;
    }

    default:
      throw new Error(`Unhandled method "${method}"`);
  }
}

// ─── Cleanup hook for unloading plugins ───────────────────────

export { cancelForPlugin as cancelPluginDialogs } from './host-dialog';
