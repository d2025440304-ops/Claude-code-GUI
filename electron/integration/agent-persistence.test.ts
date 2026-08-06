/**
 * AgentPersistence — 内存 SQLite 集成测试（P0 去重 / A5 幽灵消息回滚）。
 *
 * 与 agent-text-accumulator 的纯函数测试不同，这里直接验证"落库"结果：
 * - 多个 delta + 最终 text 落库后文本只出现一次；
 * - 同一回合多条 assistant message 顺序落库；
 * - flush 后临时状态清理，新回合不污染上一轮；
 * - A5：无回复产出时 error → 精确回滚 user message，不影响已有历史。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { MessageRepo } from '../db/repositories/message-repo';
import { ConversationRepo } from '../db/repositories/conversation-repo';
import { AgentPersistence } from './agent-persistence';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
  }
  // 与 AppDatabase.ensureColumns 对齐：attachments / kind 由代码补列
  const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!msgCols.some((c) => c.name === 'attachments')) {
    db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
  }
  const convCols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[];
  if (!convCols.some((c) => c.name === 'kind')) {
    db.exec("ALTER TABLE conversations ADD COLUMN kind TEXT DEFAULT 'chat'");
  }
  db.pragma('foreign_keys = ON');
  return db;
}

function textParts(msgs: { content: string }[]): string[] {
  return msgs.map((m) => {
    try {
      const parsed = JSON.parse(m.content);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((p) => p.type === 'text')
          .map((p) => p.text as string)
          .join('');
      }
    } catch { /* plain text */ }
    return m.content;
  });
}

describe('AgentPersistence (P0 落库去重)', () => {
  let db: Database.Database;
  let messageRepo: MessageRepo;
  let conversationRepo: ConversationRepo;
  let persistence: AgentPersistence;
  let convId: string;

  beforeEach(() => {
    db = createTestDb();
    messageRepo = new MessageRepo(db);
    conversationRepo = new ConversationRepo(db);
    convId = conversationRepo.create('test conv', '/tmp', 'default', 'agent').id;
    persistence = new AgentPersistence(messageRepo, conversationRepo);
  });

  afterEach(() => {
    db.close();
  });

  it('多个 delta + 最终 text：落库文本不重复（DB 级验证）', () => {
    persistence.onTextDelta(convId, 'msg-1', 'Hello ');
    persistence.onTextDelta(convId, 'msg-1', 'world');
    persistence.onText(convId, 'msg-1', 'Hello world');
    persistence.onToolUse(convId, 'Bash', 'toolu_1', { command: 'ls' });
    persistence.flush(convId);

    const msgs = messageRepo.getByConversation(convId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    const parts = JSON.parse(msgs[0].content) as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: 'Hello world' });
    // 全文只出现一次（防重复的硬性断言）
    expect(msgs[0].content.match(/Hello world/g)).toHaveLength(1);
    // tool_use 块保留
    expect(parts[1]).toMatchObject({ type: 'tool_use', toolUseId: 'toolu_1' });
  });

  it('同一回合多条 assistant message 保持到达顺序', () => {
    persistence.onText(convId, 'm1', 'First ');
    persistence.onTextDelta(convId, 'm2', 'Sec');
    persistence.onText(convId, 'm2', 'Second');
    persistence.flush(convId);
    expect(textParts(messageRepo.getByConversation(convId))).toEqual(['First Second']);
  });

  it('flush 后临时状态清理，新回合不污染上一轮', () => {
    persistence.onText(convId, 'm1', 'turn one');
    persistence.flush(convId);
    persistence.onTextDelta(convId, 'm2', 'turn two');
    persistence.flush(convId);

    const msgs = messageRepo.getByConversation(convId);
    expect(msgs).toHaveLength(2);
    expect(textParts(msgs)).toEqual(['turn one', 'turn two']);
  });
});

describe('AgentPersistence (A5 幽灵用户消息回滚)', () => {
  let db: Database.Database;
  let messageRepo: MessageRepo;
  let conversationRepo: ConversationRepo;
  let persistence: AgentPersistence;
  let convId: string;

  beforeEach(() => {
    db = createTestDb();
    messageRepo = new MessageRepo(db);
    conversationRepo = new ConversationRepo(db);
    convId = conversationRepo.create('test conv', '/tmp', 'default', 'agent').id;
    persistence = new AgentPersistence(messageRepo, conversationRepo);
  });

  afterEach(() => {
    db.close();
  });

  it('无回复产出时 error → 精确回滚本次 user message，不影响已有历史', () => {
    messageRepo.create(convId, 'user', 'old question');
    const ghost = messageRepo.create(convId, 'user', 'ghost question');
    persistence.registerPendingUserMessage(convId, ghost.id);

    // 没有任何产出事件 → 启动失败判定 → 回滚
    persistence.rollbackPendingUserMessage(convId);

    const msgs = messageRepo.getByConversation(convId);
    expect(msgs.map((m) => m.content)).toEqual(['old question']);
  });

  it('已有回复产出后 error → 不回滚', () => {
    const sent = messageRepo.create(convId, 'user', 'question');
    persistence.registerPendingUserMessage(convId, sent.id);
    // 回复已开始
    persistence.markOutputStarted(convId);

    persistence.rollbackPendingUserMessage(convId);
    expect(messageRepo.getByConversation(convId)).toHaveLength(1);
  });

  it('回滚后预览恢复为前一条消息', () => {
    messageRepo.create(convId, 'user', 'old question');
    const ghost = messageRepo.create(convId, 'user', 'ghost question');
    conversationRepo.updateLastMessage(convId, 'ghost question');
    persistence.registerPendingUserMessage(convId, ghost.id);

    persistence.rollbackPendingUserMessage(convId);

    expect(conversationRepo.getById(convId)?.lastMessage).toBe('old question');
  });
});
