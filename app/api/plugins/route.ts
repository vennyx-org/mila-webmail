import { NextResponse } from 'next/server';
import { getPluginRegistry, getThemeRegistry } from '@/lib/admin/plugin-registry';
import { listDevPlugins } from '@/lib/admin/plugin-dev';
import { logger } from '@/lib/logger';

/**
 * GET /api/plugins - Public endpoint for clients to discover server-managed plugins & themes
 *
 * Returns all enabled plugins and themes so the client can sync them to IndexedDB.
 * No admin auth required - this is how regular users receive plugins/themes.
 */
export async function GET() {
  try {
    const [pluginRegistry, themeRegistry, devEntries] = await Promise.all([
      getPluginRegistry(),
      getThemeRegistry(),
      listDevPlugins(),
    ]);

    // Dev plugins win on id collision so a developer can shadow an installed
    // plugin without uninstalling it first.
    const devIds = new Set(devEntries.map(e => e.plugin.id));
    const installedEnabled = pluginRegistry.plugins.filter(p => p.enabled && !devIds.has(p.id));

    const plugins = [
      ...devEntries.map(e => ({ ...e.plugin, dev: true })),
      ...installedEnabled.map(p => ({ ...p, dev: false })),
    ].map(p => ({
      id: p.id,
      name: p.name,
      version: p.version,
      author: p.author,
      description: p.description,
      type: p.type,
      permissions: p.permissions,
      entrypoint: p.entrypoint,
      forceEnabled: p.forceEnabled || false,
      // Content hash + updatedAt let clients detect re-uploads even when
      // the manifest version is unchanged.
      bundleHash: p.bundleHash,
      updatedAt: p.updatedAt,
      // Marks plugins loaded from PLUGIN_DEV_DIR. Surface in UI as a badge.
      dev: p.dev,
      // Surface so clients can enforce api.http.fetch origin allowlists.
      httpOrigins: p.httpOrigins,
      // Surface so clients can enforce api.http.post path allowlists.
      apiPostPaths: p.apiPostPaths,
      // Per-user settings schema, captured from the manifest at upload/load
      // time so the client can render the settings UI without re-parsing.
      settingsSchema: p.settingsSchema,
    }));

    // Only serve enabled themes
    const themes = themeRegistry.themes
      .filter(t => t.enabled)
      .map(t => ({
        id: t.id,
        name: t.name,
        version: t.version,
        author: t.author,
        description: t.description,
        variants: t.variants,
        forceEnabled: t.forceEnabled || false,
      }));

    return NextResponse.json(
      { plugins, themes },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logger.error('Plugin list error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
