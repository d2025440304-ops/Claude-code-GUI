import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface Attachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  size: number;
  mimeType?: string;
  dataUrl?: string;
  path?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  timestamp: string;
  attachments?: Attachment[];
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  timestamp: string;
  attachments: string | null;
}

/**
 * Data-access layer for the `messages` table.
 *
 * Rows are mapped from snake_case columns to camelCase {@link Message} objects.
 */
export class MessageRepo {
  constructor(private db: Database) {}

  /** Return all messages for a conversation, ordered oldest-first. */
  getByConversation(convId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`,
      )
      .all(convId) as MessageRow[];

    return rows.map((r) => this.mapRow(r));
  }

  /** Insert a message and return the fully-populated object. */
  create(convId: string, role: string, content: string, attachments?: Attachment[]): Message {
    const id = randomUUID();
    const now = new Date().toISOString();
    const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;

    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, timestamp, attachments)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, convId, role, content, now, attachmentsJson);

    return {
      id,
      conversationId: convId,
      role,
      content,
      timestamp: now,
      attachments: attachments ?? [],
    };
  }

  /** Overwrite the content of an existing message (used for streaming). */
  updateContent(id: string, content: string): void {
    this.db
      .prepare(`UPDATE messages SET content = ? WHERE id = ?`)
      .run(content, id);
  }

  /** Delete a single message by id. */
  delete(id: string): void {
    this.db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
  }

  /** Delete all messages belonging to a conversation. */
  deleteByConversation(convId: string): void {
    this.db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(convId);
  }

  // --- helpers -------------------------------------------------------------

  private mapRow(r: MessageRow): Message {
    let attachments: Attachment[] = [];
    if (r.attachments) {
      try { attachments = JSON.parse(r.attachments) as Attachment[]; } catch { attachments = []; }
    }
    return {
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
      attachments,
    };
  }
}
