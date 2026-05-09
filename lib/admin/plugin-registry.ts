import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { logger } from '@/lib/logger';
import { getConfigDir, assertWritable } from './paths';

function getPluginsDir(): string {
  return path.join(getConfigDir(), 'plugins');
}

function getThemesDir(): string {
  return path.join(getConfigDir(), 'themes');
}

// ─── Types ───────────────────────────────────────────────────

export interface PluginConfigField {
  type: 'string' | 'secret' | 'boolean' | 'number' | 'select';
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  options?: { label: string; value: string }[];
}

/**
 * Per-user setting field, mirrors the manifest's `settingsSchema` shape
 * (see lib/plugin-types.ts SettingFieldSchema). The server passes these
 * through unchanged so the client can render the per-user settings UI.
 */
export interface PluginSettingsField {
  type: 'boolean' | 'string' | 'number' | 'select';
  label: string;
  description?: string;
  default: unknown;
  options?: string[];
  min?: number;
  max?: number;
}

export interface ServerPlugin {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: string;
  permissions: string[];
  entrypoint: string;
  enabled: boolean;
  forceEnabled?: boolean;
  configSchema?: Record<string, PluginConfigField>;
  settingsSchema?: Record<string, PluginSettingsField>;
  installedAt: string;
  updatedAt: string;
  /**
   * SHA-256 hex of the bundle code (first 16 chars). Refreshed every save so
   * the same version re-uploaded with new code still appears as a change to
   * the client. Also doubles as the HTTP ETag for the bundle endpoint.
   */
  bundleHash?: string;
  /**
   * Validated CSP origins (https-only, single-origin form) the plugin may
   * embed. Merged into the host frame-src by the proxy.
   */
  frameOrigins?: string[];
  /**
   * Validated HTTPS origins the plugin may target via `api.http.fetch()`.
   * Same syntax as `frameOrigins`. Surfaced to clients via /api/plugins.
   */
  httpOrigins?: string[];
}

export interface ServerTheme {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  variants: string[];
  enabled: boolean;
  forceEnabled?: boolean;
  installedAt: string;
  updatedAt: string;
}

interface PluginRegistry {
  plugins: ServerPlugin[];
}

interface ThemeRegistry {
  themes: ServerTheme[];
}

// ─── Plugin Registry ─────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    logger.warn(`Failed to read ${filePath}`, { error: error instanceof Error ? error.message : 'Unknown error' });
    return fallback;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

// ─── Plugin Operations ───────────────────────────────────────

const pluginRegistryPath = () => path.join(getPluginsDir(), 'registry.json');

export async function getPluginRegistry(): Promise<PluginRegistry> {
  return readJsonFile<PluginRegistry>(pluginRegistryPath(), { plugins: [] });
}

export async function getPlugin(id: string): Promise<ServerPlugin | null> {
  const registry = await getPluginRegistry();
  return registry.plugins.find(p => p.id === id) || null;
}

export async function savePlugin(
  plugin: ServerPlugin,
  code: string,
): Promise<void> {
  assertWritable('install plugin');
  const dir = getPluginsDir();
  await ensureDir(dir);

  // Save code bundle
  const bundlePath = path.join(dir, `${plugin.id}.js`);
  await writeFile(bundlePath, code, 'utf-8');

  // Stamp content hash + updatedAt so clients can detect re-uploads even
  // when the manifest version hasn't changed. Preserve the original
  // installedAt across re-uploads.
  const bundleHash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  const now = new Date().toISOString();

  const registry = await getPluginRegistry();
  const idx = registry.plugins.findIndex(p => p.id === plugin.id);
  const next: ServerPlugin = {
    ...plugin,
    bundleHash,
    updatedAt: now,
    installedAt: idx >= 0 ? registry.plugins[idx].installedAt : plugin.installedAt,
  };
  if (idx >= 0) {
    registry.plugins[idx] = next;
  } else {
    registry.plugins.push(next);
  }
  await writeJsonFile(pluginRegistryPath(), registry);
}

export async function updatePluginMeta(id: string, updates: Partial<Pick<ServerPlugin, 'enabled' | 'forceEnabled'>>): Promise<ServerPlugin | null> {
  assertWritable('update plugin metadata');
  const registry = await getPluginRegistry();
  const idx = registry.plugins.findIndex(p => p.id === id);
  if (idx < 0) return null;

  registry.plugins[idx] = { ...registry.plugins[idx], ...updates, updatedAt: new Date().toISOString() };
  await writeJsonFile(pluginRegistryPath(), registry);
  return registry.plugins[idx];
}

export async function deletePlugin(id: string): Promise<boolean> {
  assertWritable('delete plugin');
  const registry = await getPluginRegistry();
  const idx = registry.plugins.findIndex(p => p.id === id);
  if (idx < 0) return false;

  registry.plugins.splice(idx, 1);
  await writeJsonFile(pluginRegistryPath(), registry);

  // Remove bundle file
  const bundlePath = path.join(getPluginsDir(), `${id}.js`);
  try { await unlink(bundlePath); } catch { /* ok if missing */ }

  return true;
}

export async function getPluginBundle(id: string): Promise<string | null> {
  const bundlePath = path.join(getPluginsDir(), `${id}.js`);
  try {
    return await readFile(bundlePath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Theme Operations ────────────────────────────────────────

const themeRegistryPath = () => path.join(getThemesDir(), 'registry.json');

export async function getThemeRegistry(): Promise<ThemeRegistry> {
  return readJsonFile<ThemeRegistry>(themeRegistryPath(), { themes: [] });
}

export async function getTheme(id: string): Promise<ServerTheme | null> {
  const registry = await getThemeRegistry();
  return registry.themes.find(t => t.id === id) || null;
}

export async function saveTheme(
  theme: ServerTheme,
  css: string,
): Promise<void> {
  assertWritable('install theme');
  const dir = getThemesDir();
  await ensureDir(dir);

  // Save CSS file
  const cssPath = path.join(dir, `${theme.id}.css`);
  await writeFile(cssPath, css, 'utf-8');

  // Update registry
  const registry = await getThemeRegistry();
  const idx = registry.themes.findIndex(t => t.id === theme.id);
  if (idx >= 0) {
    registry.themes[idx] = theme;
  } else {
    registry.themes.push(theme);
  }
  await writeJsonFile(themeRegistryPath(), registry);
}

export async function updateThemeMeta(id: string, updates: Partial<Pick<ServerTheme, 'enabled' | 'forceEnabled'>>): Promise<ServerTheme | null> {
  assertWritable('update theme metadata');
  const registry = await getThemeRegistry();
  const idx = registry.themes.findIndex(t => t.id === id);
  if (idx < 0) return null;

  registry.themes[idx] = { ...registry.themes[idx], ...updates, updatedAt: new Date().toISOString() };
  await writeJsonFile(themeRegistryPath(), registry);
  return registry.themes[idx];
}

export async function deleteTheme(id: string): Promise<boolean> {
  assertWritable('delete theme');
  const registry = await getThemeRegistry();
  const idx = registry.themes.findIndex(t => t.id === id);
  if (idx < 0) return false;

  registry.themes.splice(idx, 1);
  await writeJsonFile(themeRegistryPath(), registry);

  // Remove CSS file
  const cssPath = path.join(getThemesDir(), `${id}.css`);
  try { await unlink(cssPath); } catch { /* ok if missing */ }

  return true;
}

export async function getThemeCSS(id: string): Promise<string | null> {
  const cssPath = path.join(getThemesDir(), `${id}.css`);
  try {
    return await readFile(cssPath, 'utf-8');
  } catch {
    return null;
  }
}
