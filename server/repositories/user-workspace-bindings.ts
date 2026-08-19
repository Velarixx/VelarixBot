// Durable SaaS computer/workspace ownership. This is deliberately distinct
// from computer-bindings.ts, whose bot-keyed rows remain the legacy desktop
// provider cache and are not safe to use as a tenant authorization boundary.
import type { SqliteDatabase } from "../db/sqlite-native.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertOwnerId(ownerId: string): void {
  if (!UUID_PATTERN.test(ownerId)) throw new TypeError("ownerId must be an internal UUID");
}

function assertOpaqueIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

export interface UserWorkspaceBinding {
  userId: string;
  providerKind: string;
  machineId: string;
  createdAt: number;
  updatedAt: number;
}

interface UserWorkspaceBindingRow {
  user_id: string;
  provider_kind: string;
  machine_id: string;
  created_at: number;
  updated_at: number;
}

export interface UserWorkspaceBindingsRepository {
  /** Bind all access to a validated internal principal UUID. The returned
   * interface has no owner parameter that a later route could substitute. */
  forOwner(ownerId: string): OwnedUserWorkspaceBindingsRepository;
}

export interface OwnedUserWorkspaceBindingsRepository {
  get(): UserWorkspaceBinding | null;
  /** One SQLite statement inserts or updates this owner's binding. The
   * database rejects an unknown owner or a provider/machine pair owned by a
   * different user without partially changing either binding. */
  record(providerKind: string, machineId: string, now?: number): void;
  /** Delete only if both the owner and expected opaque identity still match. */
  delete(providerKind: string, machineId: string): boolean;
}

function toBinding(row: UserWorkspaceBindingRow): UserWorkspaceBinding {
  return {
    userId: row.user_id,
    providerKind: row.provider_kind,
    machineId: row.machine_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createUserWorkspaceBindingsRepository(db: SqliteDatabase): UserWorkspaceBindingsRepository {
  const selectForOwner = db.prepare<UserWorkspaceBindingRow>(
    `SELECT user_id, provider_kind, machine_id, created_at, updated_at
     FROM user_workspace_bindings WHERE user_id = ?`,
  );
  const recordForOwner = db.prepare(
    `INSERT INTO user_workspace_bindings(user_id, provider_kind, machine_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       provider_kind = excluded.provider_kind,
       machine_id = excluded.machine_id,
       updated_at = excluded.updated_at`,
  );
  const deleteForOwner = db.prepare(
    `DELETE FROM user_workspace_bindings
     WHERE user_id = ? AND provider_kind = ? AND machine_id = ?`,
  );

  return {
    forOwner(ownerId) {
      assertOwnerId(ownerId);
      return {
        get() {
          const row = selectForOwner.get(ownerId);
          return row ? toBinding(row) : null;
        },
        record(providerKind, machineId, now = Date.now()) {
          assertOpaqueIdentifier(providerKind, "providerKind");
          assertOpaqueIdentifier(machineId, "machineId");
          recordForOwner.run(ownerId, providerKind, machineId, now, now);
        },
        delete(providerKind, machineId) {
          assertOpaqueIdentifier(providerKind, "providerKind");
          assertOpaqueIdentifier(machineId, "machineId");
          return deleteForOwner.run(ownerId, providerKind, machineId).changes > 0;
        },
      };
    },
  };
}
