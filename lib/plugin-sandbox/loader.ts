// Iframe-based plugin loader. Replaces the blob-URL `import()` flow in
// `lib/plugin-loader.ts` with a postMessage-isolated sandbox.

import type { Disposable, InstalledPlugin } from '../plugin-types';
import { pluginStorage } from '../plugin-storage';
import {
  emailHooks, calendarHooks, calendarFormHooks, contactHooks, fileHooks,
  authHooks, settingsHooks, identityHooks, filterHooks,
  taskHooks, templateHooks, smimeHooks, vacationHooks,
  uiHooks, themeHooks, toastHooks, dragDropHooks,
  keyboardHooks, appLifecycleHooks, accountSecurityHooks,
  sidebarAppHooks, avatarHooks, renderHooks, routerHooks,
  removeAllPluginHooks, pluginErrorTracker,
} from '../plugin-hooks';
import { verifyBundle } from './bundle-integrity';
import { createBackgroundInstance } from './host-bridge';
import { register as registerActive, deregister as deregisterActive } from './registry';
import { cancelPluginDialogs } from './host-api';
import { registerShortcuts } from './shortcuts';

// ─── Hook-bus lookup (one flat map for name → bus) ────────────

type AnyBus = { register: (pluginId: string, handler: (...args: unknown[]) => unknown, order?: number) => Disposable };

const HOOK_BUSES: Record<string, AnyBus> = Object.assign({},
  emailHooks, calendarHooks, calendarFormHooks, contactHooks, fileHooks,
  authHooks, settingsHooks, identityHooks, filterHooks,
  taskHooks, templateHooks, smimeHooks, vacationHooks,
  uiHooks, themeHooks, toastHooks, dragDropHooks,
  keyboardHooks, appLifecycleHooks, accountSecurityHooks,
  sidebarAppHooks, avatarHooks, renderHooks, routerHooks,
) as Record<string, AnyBus>;

// ─── Store accessor (status updates flow through the existing store) ──

type StoreAccessor = { setPluginStatus: (id: string, status: InstalledPlugin['status'], error?: string) => void };
let storeAccessor: StoreAccessor | null = null;
export function setSandboxStoreAccessor(a: StoreAccessor): void { storeAccessor = a; }

// ─── Locale (kept in step with the app locale) ────────────────

let currentLocale = 'en';
export function setSandboxLocale(locale: string): void {
  currentLocale = locale;
  // Push to all active background instances.
  // Slot iframes inherit locale at spawn time; they're short-lived.
  // (We don't import the registry here to avoid a circular import; the
  //  PluginIframeSlot subscribes to locale changes on its own.)
}

// ─── Bundle fetch ─────────────────────────────────────────────

async function getBundleCode(plugin: InstalledPlugin): Promise<string> {
  // Dev plugins are written into IndexedDB by the same install flow; the
  // bundle endpoint is the source of truth for managed plugins. For Phase 1
  // we read from IndexedDB to match the existing flow; the store-side install
  // path already populates this from /api/admin/plugins/[id]/bundle.
  const code = await pluginStorage.getCode(plugin.id);
  if (!code) {
    throw new Error(`No bundle in storage for plugin "${plugin.id}". Reinstall to populate.`);
  }
  await verifyBundle(code, plugin.bundleHash);
  return code;
}

// ─── Load ─────────────────────────────────────────────────────

export async function loadSandboxedPlugin(plugin: InstalledPlugin): Promise<void> {
  if (typeof window === 'undefined') return;

  try {
    const code = await getBundleCode(plugin);
    const background = createBackgroundInstance({
      plugin,
      code,
      locale: currentLocale,
    });

    // Wait for the background runtime to evaluate the bundle, register hooks,
    // and enumerate slots.
    const info = await background.initPromise;

    // Wire hook proxies: every hookName the plugin registered gets a HookBus
    // entry whose handler dispatches into the sandbox. `shortcut:<id>` hooks
    // are dispatched by the keyboard module separately and don't have a bus.
    const hookDisposables: Disposable[] = [];
    for (const hookName of info.hooks) {
      if (hookName.startsWith('shortcut:')) continue;
      const bus = HOOK_BUSES[hookName];
      if (!bus) {
        console.warn(`[plugin-sandbox] Plugin "${plugin.id}" registered unknown hook "${hookName}"`);
        continue;
      }
      const proxy = async (...args: unknown[]) => {
        try {
          return await background.invokeHook(hookName, args);
        } catch (err) {
          pluginErrorTracker.record(plugin.id, err);
          throw err;
        }
      };
      hookDisposables.push(bus.register(plugin.id, proxy as (...a: unknown[]) => unknown));
    }

    // Install plugin-declared keyboard shortcuts.
    const shortcutDispose = registerShortcuts(background, info.shortcuts ?? []);
    hookDisposables.push({ dispose: shortcutDispose });

    registerActive({
      plugin,
      code,
      background,
      slotOffers: info.slots,
      hookDisposables,
    });

    storeAccessor?.setPluginStatus(plugin.id, 'running');
    console.info(`[plugin-sandbox] "${plugin.id}" activated (hooks=${info.hooks.length}, slots=${info.slots.length})`);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    storeAccessor?.setPluginStatus(plugin.id, 'error', msg);
    console.error(`[plugin-sandbox] Failed to load "${plugin.id}":`, err);
  }
}

// ─── Unload ───────────────────────────────────────────────────

export function unloadSandboxedPlugin(pluginId: string): void {
  const entry = deregisterActive(pluginId);
  if (!entry) return;
  for (const d of entry.hookDisposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  removeAllPluginHooks(pluginId);
  try { entry.background.destroy(); } catch { /* ignore */ }
  cancelPluginDialogs(pluginId);
  pluginErrorTracker.reset(pluginId);
  storeAccessor?.setPluginStatus(pluginId, 'disabled');
  console.info(`[plugin-sandbox] "${pluginId}" deactivated`);
}

// ─── Bulk ─────────────────────────────────────────────────────

export async function activateAllSandboxed(plugins: InstalledPlugin[]): Promise<void> {
  const enabled = plugins.filter(p => p.enabled && p.status !== 'error');
  for (const p of enabled) await loadSandboxedPlugin(p);
}

export function deactivateAllSandboxed(): void {
  // import lazily to avoid a circular dep when registry mutates while we iterate.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { all } = require('./registry') as typeof import('./registry');
  for (const e of all()) unloadSandboxedPlugin(e.plugin.id);
}

// ─── Auto-disable ─────────────────────────────────────────────

export function setupSandboxAutoDisable(): void {
  pluginErrorTracker.setAutoDisableCallback((pluginId) => {
    unloadSandboxedPlugin(pluginId);
    storeAccessor?.setPluginStatus(pluginId, 'error', 'Auto-disabled due to repeated errors');
  });
}

// ─── Re-export for compat with the existing loader name ───────

export { SandboxInstance } from './host-bridge';
