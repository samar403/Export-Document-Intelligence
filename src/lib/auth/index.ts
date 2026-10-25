import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db, newId, now, tx } from "@/lib/db";

export const SESSION_COOKIE = "plimsoll_session";
const SESSION_DAYS = 30;

export interface User {
  id: string;
  email: string;
  name: string;
  is_guest: number;
}

export interface Workspace {
  id: string;
  name: string;
  plan: string;
  pack_credits: number;
  period_start: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  settings_json: string;
  created_at: string;
}

export interface Session {
  user: User | null; // null for API-key access
  workspace: Workspace;
  via: "cookie" | "api-key";
}

// ------------------------------------------------------------- Passwords ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ----------------------------------------------------------------- Users ---

export function findUserByEmail(email: string): (User & { password_hash: string | null }) | undefined {
  return db().prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as (User & { password_hash: string | null }) | undefined;
}

export function createAccount(input: { email: string; name: string; password: string | null; company?: string; guest?: boolean }) {
  return tx(() => {
    const userId = newId("usr");
    const wsId = newId("ws");
    const ts = now();
    db().prepare("INSERT INTO users (id, email, name, password_hash, is_guest, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      userId, input.email.trim().toLowerCase(), input.name.trim(), input.password ? hashPassword(input.password) : null, input.guest ? 1 : 0, ts,
    );
    db().prepare("INSERT INTO workspaces (id, name, plan, pack_credits, period_start, created_at) VALUES (?, ?, 'payg', ?, ?, ?)").run(
      wsId, (input.company?.trim() || `${input.name.trim().split(" ")[0]}'s workspace`), input.guest ? 5 : 3, ts, ts,
    );
    db().prepare("INSERT INTO memberships (user_id, workspace_id, role) VALUES (?, ?, 'owner')").run(userId, wsId);
    return { userId, workspaceId: wsId };
  });
}

export function primaryWorkspaceId(userId: string): string | null {
  const row = db().prepare("SELECT workspace_id FROM memberships WHERE user_id = ? ORDER BY rowid LIMIT 1").get(userId) as { workspace_id: string } | undefined;
  return row?.workspace_id ?? null;
}

// -------------------------------------------------------------- Sessions ---

export async function startSession(userId: string, workspaceId: string) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  db().prepare("INSERT INTO sessions (id_hash, user_id, workspace_id, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), userId, workspaceId, expires.toISOString());
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && (process.env.PLIMSOLL_PUBLIC_URL ?? "").startsWith("https"),
    path: "/",
    expires,
  });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) db().prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(token));
  jar.delete(SESSION_COOKIE);
}

function sessionFromToken(token: string): Session | null {
  const row = db()
    .prepare(
      `SELECT s.expires_at, u.id AS u_id, u.email, u.name, u.is_guest, w.*
         FROM sessions s JOIN users u ON u.id = s.user_id JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.id_hash = ?`,
    )
    .get(sha256(token)) as (Workspace & { expires_at: string; u_id: string; email: string; name: string; is_guest: number; id: string }) | undefined;
  if (!row || row.expires_at < now()) return null;
  const { expires_at: _e, u_id, email, name, is_guest, ...ws } = row;
  void _e;
  return { user: { id: u_id, email, name, is_guest }, workspace: ws as Workspace, via: "cookie" };
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? sessionFromToken(token) : null;
}

/** For server components and actions: redirect to /login when signed out. */
export async function requireSession(): Promise<Session & { user: User }> {
  const s = await getSession();
  if (!s || !s.user) redirect("/login");
  return s as Session & { user: User };
}

// --------------------------------------------------------------- API keys ---

export function createApiKey(workspaceId: string, name: string): { id: string; key: string } {
  const secret = `pls_${randomBytes(24).toString("base64url")}`;
  const id = newId("key");
  db().prepare("INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, workspaceId, name.trim() || "API key", secret.slice(0, 10), sha256(secret), now(),
  );
  return { id, key: secret };
}

export function listApiKeys(workspaceId: string) {
  return db().prepare("SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId) as {
    id: string; name: string; prefix: string; created_at: string; last_used_at: string | null;
  }[];
}

export function revokeApiKey(workspaceId: string, id: string) {
  db().prepare("DELETE FROM api_keys WHERE workspace_id = ? AND id = ?").run(workspaceId, id);
}

/** For API routes: accepts the session cookie or `Authorization: Bearer pls_…`. */
export async function apiSession(req: Request): Promise<Session | null> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const key = auth.slice(7).trim();
    const row = db().prepare("SELECT k.id AS key_id, w.* FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id WHERE k.key_hash = ?").get(sha256(key)) as
      | (Workspace & { key_id: string })
      | undefined;
    if (!row) return null;
    db().prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), row.key_id);
    const { key_id: _k, ...ws } = row;
    void _k;
    return { user: null, workspace: ws as Workspace, via: "api-key" };
  }
  return getSession();
}
