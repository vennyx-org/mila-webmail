import { readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { logger } from '@/lib/logger';
import {
  ensureConfigDir,
  ensureStateDir,
  getConfigPath,
  getStatePath,
  isConfigReadOnly,
} from './paths';
import type { AdminConfigData, AdminStateData } from './types';

const MIGRATION_MARKER = '.migrated-v2';

interface LegacyAdminData {
  passwordHash: string;
  createdAt?: string;
  lastLogin?: string | null;
  passwordChangedAt?: string;
}

/**
 * One-shot migration from the v1 layout (everything mixed in `data/admin/`)
 * to the v2 layout (config + state split, see lib/admin/paths.ts).
 *
 * Idempotent: writes a `.migrated-v2` marker into the config dir on success.
 *
 * Migrations performed:
 *   1. admin.json with timestamps → admin.json (passwordHash only) +
 *      admin-state.json (createdAt, lastLogin, passwordChangedAt)
 *   2. audit.log moved from config dir to state dir (by rename if same FS,
 *      else copy + delete).
 *
 * Skipped silently when the config dir is read-only - operators who already
 * locked their config volume must do the migration manually before mounting
 * :ro.
 */
export async function migrateLegacyAdminLayout(): Promise<void> {
  if (isConfigReadOnly()) return;

  const markerPath = getConfigPath(MIGRATION_MARKER);
  if (existsSync(markerPath)) return;

  let didWork = false;

  try {
    didWork = (await migrateAdminJson()) || didWork;
    didWork = (await migrateAuditLog()) || didWork;

    await ensureConfigDir();
    await writeFile(markerPath, new Date().toISOString(), 'utf-8');
    if (didWork) {
      logger.info('Admin layout migrated to v2 (config/state split)');
    }
  } catch (error) {
    logger.warn('Admin layout migration failed; will retry on next boot', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * If the existing admin.json carries timestamp fields (legacy mixed layout),
 * split them into admin-state.json and rewrite admin.json without them.
 * Returns true if a migration was performed.
 */
async function migrateAdminJson(): Promise<boolean> {
  const adminJsonPath = getConfigPath('admin.json');
  if (!existsSync(adminJsonPath)) return false;

  let raw: string;
  try {
    raw = await readFile(adminJsonPath, 'utf-8');
  } catch {
    return false;
  }

  let data: LegacyAdminData;
  try {
    data = JSON.parse(raw) as LegacyAdminData;
  } catch {
    logger.warn('admin.json is not valid JSON; skipping migration');
    return false;
  }

  const hasLegacyFields =
    'createdAt' in data || 'lastLogin' in data || 'passwordChangedAt' in data;
  if (!hasLegacyFields) return false; // already in v2 shape

  if (!data.passwordHash || typeof data.passwordHash !== 'string') {
    logger.warn('admin.json missing passwordHash; skipping migration');
    return false;
  }

  const now = new Date().toISOString();
  const stateData: AdminStateData = {
    createdAt: data.createdAt ?? now,
    lastLogin: data.lastLogin ?? null,
    passwordChangedAt: data.passwordChangedAt ?? now,
  };
  const configData: AdminConfigData = { passwordHash: data.passwordHash };

  await ensureStateDir();
  const statePath = getStatePath('admin-state.json');

  // If admin-state.json already exists, prefer its values: a previous
  // migration may have succeeded and recorded fresh login timestamps that
  // we'd otherwise stomp. The legacy admin.json data is older by definition.
  if (!existsSync(statePath)) {
    const stateTmp = statePath + '.tmp';
    await writeFile(stateTmp, JSON.stringify(stateData, null, 2), 'utf-8');
    await rename(stateTmp, statePath);
  }

  const configTmp = adminJsonPath + '.tmp';
  await writeFile(configTmp, JSON.stringify(configData, null, 2), 'utf-8');
  await rename(configTmp, adminJsonPath);

  logger.info('Migrated admin.json: split timestamps into admin-state.json');
  return true;
}

/**
 * Move audit.log from the config dir to the state dir if present. Returns
 * true if a migration was performed. Also moves rotated copies (audit.log.1
 * through .3).
 */
async function migrateAuditLog(): Promise<boolean> {
  const sources = [
    'audit.log',
    'audit.log.1',
    'audit.log.2',
    'audit.log.3',
  ];

  let moved = false;
  for (const name of sources) {
    const src = getConfigPath(name);
    if (!existsSync(src)) continue;

    await ensureStateDir();
    const dst = getStatePath(name);

    try {
      // Same-FS rename is atomic. Falls through to copy if cross-device.
      await rename(src, dst);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        // Cross-device: copy bytes, then delete source.
        const data = await readFile(src);
        await writeFile(dst, data);
        await unlink(src);
      } else {
        throw error;
      }
    }
    moved = true;
  }

  if (moved) {
    logger.info('Migrated audit.log to state dir');
  }
  return moved;
}

/**
 * Returns approximate size of legacy data still mixed in the config dir
 * (for diagnostics / admin UI). Always returns 0 once migration has run.
 */
export async function getLegacyDataInfo(): Promise<{ adminJsonHasTimestamps: boolean; auditLogInConfigDir: boolean }> {
  let adminJsonHasTimestamps = false;
  const adminJsonPath = getConfigPath('admin.json');
  if (existsSync(adminJsonPath)) {
    try {
      const raw = await readFile(adminJsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      adminJsonHasTimestamps =
        'createdAt' in parsed ||
        'lastLogin' in parsed ||
        'passwordChangedAt' in parsed;
    } catch {
      /* ignore */
    }
  }

  let auditLogInConfigDir = false;
  try {
    await stat(getConfigPath('audit.log'));
    auditLogInConfigDir = true;
  } catch {
    /* not present - good */
  }

  return { adminJsonHasTimestamps, auditLogInConfigDir };
}
