import crypto from 'node:crypto';

import { ensureAuthTables, getPool, query, queryOne } from '@agentic-ug/db';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._@-]{2,63}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const SCRYPT_KEY_LENGTH = 64;
const HASH_PREFIX = 'scrypt';

interface DashboardUserRow {
  username: string;
  password_hash: string;
  display_name: string;
}

export interface DashboardAccount {
  username: string;
  displayName: string;
}

export type RegistrationResult =
  | { ok: true; account: DashboardAccount }
  | { ok: false; reason: 'invalid_username' | 'invalid_password' | 'username_exists' };

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `${HASH_PREFIX}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [prefix, saltText, hashText] = storedHash.split('$');
  if (prefix !== HASH_PREFIX || saltText === undefined || hashText === undefined) return false;

  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function registerDashboardAccount(
  rawUsername: string,
  password: string,
): Promise<RegistrationResult> {
  const username = normalizeUsername(rawUsername);
  if (!isValidUsername(username)) return { ok: false, reason: 'invalid_username' };
  if (!isValidPassword(password)) return { ok: false, reason: 'invalid_password' };

  await ensureAuthTables(getPool());
  try {
    await query(
      `INSERT INTO dashboard_user (username, password_hash, display_name)
       VALUES ($1, $2, $3)`,
      [username, hashPassword(password), username],
    );
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'username_exists' };
    throw error;
  }

  return { ok: true, account: { username, displayName: username } };
}

export async function verifyDashboardCredentials(
  rawUsername: string,
  password: string,
): Promise<DashboardAccount | undefined> {
  const username = normalizeUsername(rawUsername);
  if (!isValidUsername(username) || !isValidPassword(password)) return undefined;

  await ensureAuthTables(getPool());
  const row = await queryOne<DashboardUserRow>(
    `SELECT username, password_hash, display_name
       FROM dashboard_user
      WHERE username = $1`,
    [username],
  );
  if (row === undefined || !verifyPassword(password, row.password_hash)) return undefined;

  return {
    username: row.username,
    displayName: row.display_name === '' ? row.username : row.display_name,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
