// Plugin loader entrypoint. Delegates to the iframe-based sandbox in
// `lib/plugin-sandbox/`. The legacy blob-URL `import()` path has been
// removed; plugin bundles now run in a null-origin sandbox iframe and
// communicate with the host via postMessage RPC.

import type { InstalledPlugin } from './plugin-types';
import {
  loadSandboxedPlugin,
  unloadSandboxedPlugin,
  activateAllSandboxed,
  deactivateAllSandboxed,
  setSandboxStoreAccessor,
  setSandboxLocale,
  setupSandboxAutoDisable,
} from './plugin-sandbox/loader';
import { all as allActive, get as getActive } from './plugin-sandbox/registry';

/**
 * Previously: re-published React/ReactDOM on `globalThis.__PLUGIN_EXTERNALS__`
 * so blob-imported plugin code could resolve `react`. With the sandbox model
 * plugins receive React injected as a function argument inside their iframe
 * runtime — there is nothing to expose on the host window.
 *
 * Kept as a no-op for callers that still invoke it during app bootstrap.
 */
export function exposePluginExternals(): void {
  if (typeof window === 'undefined') return;
  // Initialise the locale sync once. Importing the store lazily avoids the
  // circular module graph we used to fight before the sandbox refactor.
  void import('@/stores/locale-store').then(({ useLocaleStore }) => {
    setSandboxLocale(useLocaleStore.getState().locale);
    useLocaleStore.subscribe((state) => setSandboxLocale(state.locale));
    // Mirror on a global so the slot-iframe component can read it at spawn.
    (globalThis as unknown as { __APP_LOCALE__?: string }).__APP_LOCALE__ = useLocaleStore.getState().locale;
    useLocaleStore.subscribe((state) => {
      (globalThis as unknown as { __APP_LOCALE__?: string }).__APP_LOCALE__ = state.locale;
    });
  }).catch(() => { /* locale sync is best-effort */ });
}

// ─── Store accessor (status updates) ──────────────────────────

type StoreAccessor = { setPluginStatus: (id: string, status: InstalledPlugin['status'], error?: string) => void };

export function setPluginStoreAccessor(accessor: StoreAccessor): void {
  setSandboxStoreAccessor(accessor);
}

// ─── Lifecycle (sandbox-backed) ───────────────────────────────

export async function loadPlugin(plugin: InstalledPlugin): Promise<void> {
  if (getActive(plugin.id)) {
    console.warn(`[plugin-loader] "${plugin.id}" is already loaded`);
    return;
  }
  await loadSandboxedPlugin(plugin);
}

export function deactivatePlugin(pluginId: string): void {
  unloadSandboxedPlugin(pluginId);
}

export async function activateAllPlugins(plugins: InstalledPlugin[]): Promise<void> {
  exposePluginExternals();
  await activateAllSandboxed(plugins);
}

export function deactivateAllPlugins(): void {
  deactivateAllSandboxed();
}

export function isPluginActive(pluginId: string): boolean {
  return getActive(pluginId) !== undefined;
}

export function setupAutoDisable(): void {
  setupSandboxAutoDisable();
}

// Re-export for stores/tests that need the active set.
export { allActive as activePlugins };
