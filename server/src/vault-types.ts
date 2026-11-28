// Saved-login shapes the apps read (server/src/vault.ts). Types only, so the phone can import them
// with `import type` from '@shared/vault-types' without pulling in the server.

/** A saved login as the apps see it: never the username or password. */
export interface LoginView {
  id: string; site: string; label: string; userHint: string; hasUsername: boolean; hasPassword: boolean;
  /** null = all of this person's bots. */
  bots: string[] | null; connectorFirst: boolean; createdAt: number; updatedAt: number; lastUsedAt: number | null; uses: number;
}

/** What the apps send to add or change a login (POST/PATCH /api/vault/logins). */
export interface LoginInput { site: string; label?: string; username?: string; password?: string; clearPassword?: boolean; bots?: string[] | 'all'; connectorFirst?: boolean }
