import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface Conversation {
  id: string;
  title: string;
  projectPath: string | null;
  model: string;
  pinned: boolean;
  kind: 'agent' | 'chat';
  claudeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessage: string | null;
}

interface ConversationRow {
  id: string;
  title: string;
  project_path: string | null;
  model: string;
  pinned: number;
  kind: string;
  claude_session_id: string | null;
  created_at: string;
  updated_at: string;
  last_message: string | null;
}

/**
 * Data-access layer for the `conversations` table.
 *
 * All methods are synchronous (better-sqlite3 is synchronous). Rows are mapped
 * from snake_case columns to camelCase {@link Conversation} objects.
 */
export class ConversationRepo {
  constructor(private db: Database) {}

  /** Return all conversations, pinned first then by updated_at desc. */
  getAll(): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC`,
      )
      .all() as ConversationRow[];

    return rows.map((r) => this.mapRow(r));
  }

  /** Fetch a single conversation by id, or null if not found. */
  getById(id: string): Conversation | null {
    const row = this.db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(id) as ConversationRow | undefined;

    return row ? this.mapRow(row) : null;
  }

  /**
   * Insert a new conversation and return the fully-populated object.
   * `pinned` defaults to false, timestamps default to now (ISO strings).
   */
  create(title: string, projectPath: string | null, model: string, kind: 'agent' | 'chat' = 'chat'): Conversation {
    const id = randomUUID();
    const now = new Date().toISOString();
    const safeKind = kind === 'agent' ? 'agent' : 'chat';

    this.db
      .prepare(
        `INSERT INTO conversations
           (id, title, project_path, model, pinned, kind, claude_session_id, created_at, updated_at, last_message)
         VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, NULL)`,
      )
      .run(id, title, projectPath, model, safeKind, now, now);

    return {
      id,
      title,
      projectPath,
      model,
      pinned: false,
      kind: safeKind,
      claudeSessionId: null,
      createdAt: now,
      updatedAt: now,
      lastMessage: null,
    };
  }

  /** Update the title of a conversation. */
  updateTitle(id: string, title: string): void {
    this.db
      .prepare(
        `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
      )
      .run(title, new Date().toISOString(), id);
  }

  /** Update the model used for this conversation (applies to subsequent messages). */
  updateModel(id: string, model: string): void {
    this.db
      .prepare(`UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?`)
      .run(model, new Date().toISOString(), id);
  }

  /** Toggle the pinned flag on a conversation. */
  togglePin(id: string, pinned: boolean): void {
    this.db
      .prepare(
        `UPDATE conversations SET pinned = ?, updated_at = ? WHERE id = ?`,
      )
      .run(pinned ? 1 : 0, new Date().toISOString(), id);
  }

  /**
   * Update the last message preview, and optionally the Claude CLI session id
   * (stored once a CLI session is established for this conversation).
   */
  updateLastMessage(id: string, message: string, claudeSessionId?: string): void {
    const now = new Date().toISOString();
    if (claudeSessionId !== undefined) {
      this.db
        .prepare(
          `UPDATE conversations
             SET last_message = ?, claude_session_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(message, claudeSessionId, now, id);
    } else {
      this.db
        .prepare(
          `UPDATE conversations SET last_message = ?, updated_at = ? WHERE id = ?`,
        )
        .run(message, now, id);
    }
  }

  /** Delete a conversation by id. Messages cascade-delete via FK. */
  delete(id: string): void {
    this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  }

  // --- helpers -------------------------------------------------------------

  private mapRow(r: ConversationRow): Conversation {
    return {
      id: r.id,
      title: r.title,
      projectPath: r.project_path,
      model: r.model,
      pinned: r.pinned === 1,
      kind: r.kind === 'agent' ? 'agent' : 'chat',
      claudeSessionId: r.claude_session_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastMessage: r.last_message,
    };
  }
}
