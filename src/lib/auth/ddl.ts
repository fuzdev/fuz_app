/**
 * Auth table DDL — CREATE TABLE, index, and seed statements.
 *
 * Consumed by `migrations.ts`. Separated from `account_schema.ts`
 * to isolate DDL concerns from runtime types.
 *
 * @module
 */

export const ACCOUNT_SCHEMA = `
CREATE TABLE IF NOT EXISTS account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
)`;

export const ACTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS actor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  updated_by UUID REFERENCES actor(id) ON DELETE SET NULL
)`;

export const ACTOR_INDEX = `
CREATE INDEX IF NOT EXISTS idx_actor_account ON actor(account_id)`;

export const PERMIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS permit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES actor(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES actor(id) ON DELETE SET NULL,
  granted_by UUID REFERENCES actor(id) ON DELETE SET NULL
)`;

export const PERMIT_INDEXES = [
	`CREATE INDEX IF NOT EXISTS idx_permit_actor ON permit(actor_id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS permit_actor_role_active_unique
    ON permit (actor_id, role) WHERE revoked_at IS NULL`,
];

export const AUTH_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_session (
  id TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

export const AUTH_SESSION_INDEXES = [
	`CREATE INDEX IF NOT EXISTS idx_auth_session_account ON auth_session(account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_auth_session_expires ON auth_session(expires_at)`,
];

export const API_TOKEN_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_token (
  id TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

export const ACCOUNT_EMAIL_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email ON account (LOWER(email)) WHERE email IS NOT NULL`;

export const ACCOUNT_USERNAME_CI_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_username_ci ON account (LOWER(username))`;

export const API_TOKEN_INDEX = `
CREATE INDEX IF NOT EXISTS idx_api_token_account ON api_token(account_id)`;

export const BOOTSTRAP_LOCK_SCHEMA = `
CREATE TABLE IF NOT EXISTS bootstrap_lock (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  bootstrapped BOOLEAN NOT NULL DEFAULT false
)`;

/** Seed the bootstrap_lock table, setting `bootstrapped` based on whether accounts exist. */
export const BOOTSTRAP_LOCK_SEED = `
INSERT INTO bootstrap_lock (id, bootstrapped)
  SELECT 1, EXISTS(SELECT 1 FROM account)
  ON CONFLICT DO NOTHING`;

export const INVITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS invite (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  username TEXT,
  claimed_by UUID REFERENCES account(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES actor(id) ON DELETE SET NULL,
  CONSTRAINT invite_has_identifier CHECK (email IS NOT NULL OR username IS NOT NULL)
)`;

export const INVITE_INDEXES = [
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_email_unclaimed ON invite (LOWER(email)) WHERE email IS NOT NULL AND claimed_at IS NULL`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_username_unclaimed ON invite (LOWER(username)) WHERE username IS NOT NULL AND claimed_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS idx_invite_claimed ON invite (claimed_at)`,
];

export const APP_SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  open_signup BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ,
  updated_by UUID
)`;

export const APP_SETTINGS_SEED = `
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT DO NOTHING`;
