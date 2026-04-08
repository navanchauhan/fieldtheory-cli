/**
 * Extract Instagram session cookies from Chrome-family browsers.
 *
 * Reuses the same Chrome cookie decryption infrastructure as the Twitter
 * cookie extractor, but queries for Instagram-specific cookies.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { decryptCookieValue } from './chrome-cookies.js';
import { pbkdf2Sync } from 'node:crypto';
import type { BrowserDef } from './browsers.js';
import { getKeychainEntries } from './browsers.js';

export interface InstagramCookieResult {
  sessionId: string;
  csrfToken: string;
  dsUserId: string;
  cookieHeader: string;
}

// ── Platform key derivation (duplicated minimally from chrome-cookies) ──

function getMacOSKey(browser: BrowserDef): Buffer {
  const candidates = getKeychainEntries(browser);
  for (const candidate of candidates) {
    try {
      const password = execFileSync(
        'security',
        ['find-generic-password', '-w', '-s', candidate.service, '-a', candidate.account],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      if (password) {
        return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
      }
    } catch { /* next */ }
  }
  throw new Error(
    `Could not read ${browser.displayName} Safe Storage password from macOS Keychain.\n` +
    'Fix: open the browser profile logged into Instagram, then retry.\n' +
    'Or pass cookies manually:  ft ig sync --cookies <sessionid> <csrftoken> <ds_user_id>',
  );
}

function getLinuxKeys(browser: BrowserDef): { v10: Buffer; v11: Buffer | null } {
  const v10 = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
  const appNames: Record<string, string[]> = {
    chrome: ['chrome'], chromium: ['chromium'], brave: ['brave'],
    helium: ['chrome'], comet: ['chrome'],
  };
  const apps = appNames[browser.id] ?? ['chrome'];
  for (const app of apps) {
    try {
      const pw = execFileSync('secret-tool', ['lookup', 'application', app], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
      }).trim();
      if (pw) return { v10, v11: pbkdf2Sync(pw, 'saltysalt', 1, 16, 'sha1') };
    } catch { /* next */ }
  }
  return { v10, v11: null };
}

function getWindowsKey(chromeUserDataDir: string, browser: BrowserDef): Buffer {
  const localStatePath = join(chromeUserDataDir, 'Local State');
  if (!existsSync(localStatePath)) {
    throw new Error(
      `${browser.displayName} "Local State" not found at: ${localStatePath}\n` +
      'Make sure the browser is installed and has been opened at least once.',
    );
  }
  const localState = JSON.parse(readFileSync(localStatePath, 'utf8'));
  const encryptedKeyB64: string | undefined = localState?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) throw new Error('Could not find os_crypt.encrypted_key in Local State.');

  const encryptedKeyWithPrefix = Buffer.from(encryptedKeyB64, 'base64');
  if (encryptedKeyWithPrefix.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('Encryption key does not have expected DPAPI prefix.');
  }
  const encryptedKey = encryptedKeyWithPrefix.subarray(5);

  const { spawnSync } = require('node:child_process');
  const result = spawnSync(
    'powershell',
    ['-NonInteractive', '-NoProfile', '-Command', [
      '$input | ForEach-Object {',
      '  $bytes = [System.Convert]::FromBase64String($_)',
      '  $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '  [System.Console]::WriteLine([System.Convert]::ToBase64String($dec))',
      '}',
    ].join('\n')],
    { input: encryptedKey.toString('base64'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 },
  );

  const out = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (result.status !== 0 || !out) {
    throw new Error('Could not decrypt encryption key via DPAPI.');
  }
  return Buffer.from(out, 'base64');
}

// ── SQLite query helpers ─────────────────────────────────────────────────

interface RawCookie {
  name: string;
  host_key: string;
  encrypted_value_hex: string;
  value: string;
}

function queryDbVersion(dbPath: string): number {
  const tryQuery = (p: string) =>
    execFileSync('sqlite3', [p, "SELECT value FROM meta WHERE key='version';"], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
  try {
    return parseInt(tryQuery(dbPath), 10) || 0;
  } catch {
    const tmpDb = join(tmpdir(), `ft-ig-meta-${randomUUID()}.db`);
    try {
      copyFileSync(dbPath, tmpDb);
      return parseInt(tryQuery(tmpDb), 10) || 0;
    } catch { return 0; }
    finally { try { unlinkSync(tmpDb); } catch {} }
  }
}

function resolveCookieDbPath(chromeUserDataDir: string, profileDirectory: string): string {
  const networkPath = join(chromeUserDataDir, profileDirectory, 'Network', 'Cookies');
  if (existsSync(networkPath)) return networkPath;
  return join(chromeUserDataDir, profileDirectory, 'Cookies');
}

function queryCookies(
  dbPath: string, domain: string, names: string[], browser: BrowserDef,
): { cookies: RawCookie[]; dbVersion: number } {
  if (!existsSync(dbPath)) {
    throw new Error(
      `${browser.displayName} Cookies database not found at: ${dbPath}\n` +
      'Fix: Make sure the browser is installed and has been opened at least once.',
    );
  }

  const safeDomain = domain.replace(/'/g, "''");
  const nameList = names.map(n => `'${n.replace(/'/g, "''")}'`).join(',');
  const sql = `SELECT name, host_key, hex(encrypted_value) as encrypted_value_hex, value FROM cookies WHERE host_key LIKE '%${safeDomain}' AND name IN (${nameList});`;

  const tryQuery = (path: string): string =>
    execFileSync('sqlite3', ['-json', path, sql], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    }).trim();

  let output: string;
  try {
    output = tryQuery(dbPath);
  } catch {
    const tmpDb = join(tmpdir(), `ft-ig-cookies-${randomUUID()}.db`);
    try {
      copyFileSync(dbPath, tmpDb);
      output = tryQuery(tmpDb);
    } catch (e2: any) {
      throw new Error(
        `Could not read ${browser.displayName} Cookies database.\n` +
        `Path: ${dbPath}\nError: ${e2.message}\n` +
        `Fix: If ${browser.displayName} is open, close it and retry.\n` +
        'Or pass cookies manually:  ft ig sync --cookies <sessionid> <csrftoken> <ds_user_id>',
      );
    } finally { try { unlinkSync(tmpDb); } catch {} }
  }

  const dbVersion = queryDbVersion(dbPath);
  if (!output || output === '[]') return { cookies: [], dbVersion };
  try { return { cookies: JSON.parse(output), dbVersion }; }
  catch { return { cookies: [], dbVersion }; }
}

// ── Main export ──────────────────────────────────────────────────────────

export function extractInstagramCookies(
  chromeUserDataDir: string,
  profileDirectory = 'Default',
  browser: BrowserDef | undefined = undefined,
): InstagramCookieResult {
  const os = platform();
  const br = browser ?? {
    id: 'chrome', displayName: 'Google Chrome',
    cookieBackend: 'chromium' as const, keychainEntries: [],
  };

  const dbPath = resolveCookieDbPath(chromeUserDataDir, profileDirectory);

  let key: Buffer;
  let v11Key: Buffer | null | undefined;
  let isWindows = false;

  if (os === 'darwin') {
    key = getMacOSKey(br);
  } else if (os === 'linux') {
    const linuxKeys = getLinuxKeys(br);
    key = linuxKeys.v10;
    v11Key = linuxKeys.v11;
  } else if (os === 'win32') {
    key = getWindowsKey(chromeUserDataDir, br);
    isWindows = true;
  } else {
    throw new Error(
      `Automatic cookie extraction is not supported on ${os}.\n` +
      'Pass cookies manually:  ft ig sync --cookies <sessionid> <csrftoken> <ds_user_id>',
    );
  }

  const result = queryCookies(dbPath, '.instagram.com', ['sessionid', 'csrftoken', 'ds_user_id'], br);

  const decrypted = new Map<string, string>();
  for (const cookie of result.cookies) {
    const hexVal = cookie.encrypted_value_hex;
    if (hexVal && hexVal.length > 0) {
      const buf = Buffer.from(hexVal, 'hex');
      if (isWindows) {
        // Windows DPAPI — import at runtime to avoid top-level require
        const { spawnSync } = require('node:child_process');
        const winResult = spawnSync(
          'powershell',
          ['-NonInteractive', '-NoProfile', '-Command', [
            '$input | ForEach-Object {',
            '  $bytes = [System.Convert]::FromBase64String($_)',
            '  $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
            '  [System.Console]::WriteLine([System.Text.Encoding]::UTF8.GetString($dec))',
            '}',
          ].join('\n')],
          { input: buf.toString('base64'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
        );
        const out = typeof winResult.stdout === 'string' ? winResult.stdout.trim() : '';
        if (winResult.status === 0 && out) {
          decrypted.set(cookie.name, out);
        } else {
          decrypted.set(cookie.name, buf.toString('utf8'));
        }
      } else {
        decrypted.set(cookie.name, decryptCookieValue(buf, key, result.dbVersion, v11Key));
      }
    } else if (cookie.value) {
      decrypted.set(cookie.name, cookie.value);
    }
  }

  const sessionId = decrypted.get('sessionid');
  const csrfToken = decrypted.get('csrftoken');
  const dsUserId = decrypted.get('ds_user_id');

  if (!sessionId) {
    throw new Error(
      `No sessionid cookie found for instagram.com in ${br.displayName}.\n` +
      'This means you are not logged into Instagram in this browser.\n\n' +
      'Fix:\n' +
      `  1. Open ${br.displayName}\n` +
      '  2. Go to https://www.instagram.com and log in\n' +
      '  3. Re-run this command\n\n' +
      (profileDirectory !== 'Default'
        ? `Using profile: "${profileDirectory}"\n`
        : 'Using the Default profile. If your Instagram login is in a different profile,\n' +
          'pass --chrome-profile-directory <name> (e.g., "Profile 1").\n') +
      '\nOr pass cookies manually:  ft ig sync --cookies <sessionid> <csrftoken> <ds_user_id>',
    );
  }

  if (!csrfToken) {
    throw new Error('No csrftoken cookie found for instagram.com. Make sure you are logged in.');
  }

  if (!dsUserId) {
    throw new Error('No ds_user_id cookie found for instagram.com. Make sure you are logged in.');
  }

  const cookieHeader = [
    `sessionid=${sessionId}`,
    `csrftoken=${csrfToken}`,
    `ds_user_id=${dsUserId}`,
  ].join('; ');

  return { sessionId, csrfToken, dsUserId, cookieHeader };
}
