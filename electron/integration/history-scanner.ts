/**
 * 扫描 Claude Code 历史对话记录。
 *
 * Claude Code 将对话存储在 ~/.claude/projects/ 下的 JSONL 文件中，
 * 每个文件对应一个完整的对话会话。
 *
 * 目录命名规则：绝对路径中的 / 替换为 -
 * 例如：/Users/dai/Documents → -Users-dai-Documents
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 扫描到的历史对话摘要 */
export interface HistoryConversation {
  /** 会话 UUID（文件名） */
  sessionId: string;
  /** AI 生成的标题 */
  title: string;
  /** 项目路径（从目录名还原） */
  projectPath: string;
  /** 来源：cli / vscode */
  entrypoint: string;
  /** 第一条消息的时间戳 */
  createdAt: string;
  /** 最后一条消息的时间戳 */
  updatedAt: string;
  /** 最后一条用户消息预览 */
  lastMessage: string;
  /** 消息总数（仅 user + assistant） */
  messageCount: number;
}

/** 单条历史消息 */
export interface HistoryMessage {
  uuid: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** 仅 assistant 消息：使用的模型 */
  model?: string;
  /** 仅 assistant 消息：token 用量 */
  usage?: { inputTokens: number; outputTokens: number };
}

/** 完整的历史对话（包含消息） */
export interface HistoryConversationDetail extends HistoryConversation {
  messages: HistoryMessage[];
}

// ---------------------------------------------------------------------------
// 扫描器
// ---------------------------------------------------------------------------

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/**
 * 将目录名还原为原始路径。
 * -Users-dai-Documents → /Users/dai/Documents
 */
function dirNameToPath(dirName: string): string {
  return '/' + dirName.replace(/-/g, '/');
}

/**
 * 扫描所有项目的对话摘要（不读取消息内容，速度快）。
 */
export function scanHistorySummaries(): HistoryConversation[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];

  const results: HistoryConversation[] = [];

  // 遍历项目目录
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  for (const dirName of projectDirs) {
    const projectDir = path.join(PROJECTS_DIR, dirName);
    const projectPath = dirNameToPath(dirName);

    // 扫描项目目录下的 JSONL 文件
    let jsonlFiles: string[];
    try {
      jsonlFiles = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && !f.includes('agent-'));
    } catch {
      continue;
    }

    for (const file of jsonlFiles) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectDir, file);

      try {
        const summary = parseConversationSummary(filePath, sessionId, projectPath);
        if (summary) results.push(summary);
      } catch {
        // 跳过解析失败的文件
      }
    }
  }

  // 按最后更新时间排序
  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return results;
}

/**
 * 加载单个对话的完整消息。
 */
export function loadConversationDetail(
  projectPath: string,
  sessionId: string,
): HistoryConversationDetail | null {
  // 还原目录名
  const dirName = projectPath.replace(/^\//, '').replace(/\//g, '-');
  const filePath = path.join(PROJECTS_DIR, dirName, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) return null;

  const summary = parseConversationSummary(filePath, sessionId, projectPath);
  if (!summary) return null;

  const messages = parseConversationMessages(filePath);
  return { ...summary, messages };
}

// ---------------------------------------------------------------------------
// 内部解析函数
// ---------------------------------------------------------------------------

/**
 * 快速解析对话摘要（只读前几行和最后几行获取元数据）。
 */
function parseConversationSummary(
  filePath: string,
  sessionId: string,
  projectPath: string,
): HistoryConversation | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length === 0) return null;

  let title = '';
  let entrypoint = 'cli';
  let createdAt = '';
  let updatedAt = '';
  let lastMessage = '';
  let messageCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const type = entry.type;

      // 提取 AI 标题
      if (type === 'ai-title' && entry.aiTitle) {
        title = entry.aiTitle;
        continue;
      }

      // 提取消息元数据
      if (type === 'user' || type === 'assistant') {
        // 跳过子代理和系统消息
        if (entry.isSidechain || entry.isMeta) continue;

        const ts = entry.timestamp || '';
        if (!createdAt && ts) createdAt = ts;
        if (ts) updatedAt = ts;

        if (type === 'user') {
          messageCount++;
          // 提取最后一条用户消息作为预览
          const msg = entry.message;
          if (msg?.content) {
            if (typeof msg.content === 'string') {
              lastMessage = msg.content.slice(0, 200);
            } else if (Array.isArray(msg.content)) {
              const textBlock = msg.content.find((b: any) => b.type === 'text');
              if (textBlock?.text) lastMessage = textBlock.text.slice(0, 200);
            }
          }
        } else if (type === 'assistant') {
          messageCount++;
        }

        // 提取来源
        if (entry.entrypoint) {
          entrypoint = entry.entrypoint;
        }
      }
    } catch {
      // 跳过无法解析的行
    }
  }

  // 如果没有标题，用 slug 或 session ID
  if (!title) {
    // 尝试从消息中获取 slug
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.slug) { title = entry.slug; break; }
      } catch {}
    }
    if (!title) title = sessionId.slice(0, 8);
  }

  return {
    sessionId,
    title,
    projectPath,
    entrypoint,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: updatedAt || new Date().toISOString(),
    lastMessage,
    messageCount,
  };
}

/**
 * 解析对话中的所有用户和助手消息。
 */
function parseConversationMessages(filePath: string): HistoryMessage[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const messages: HistoryMessage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const type = entry.type;

      // 跳过子代理和系统消息
      if (entry.isSidechain || entry.isMeta) continue;

      if (type === 'user') {
        const msg = entry.message;
        if (!msg?.content) continue;

        let content = '';
        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          // 过滤掉 tool_result，只保留用户文本
          const textParts = msg.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text);
          content = textParts.join('\n');
        }

        if (!content.trim()) continue;

        messages.push({
          uuid: entry.uuid,
          role: 'user',
          content,
          timestamp: entry.timestamp || '',
        });
      } else if (type === 'assistant') {
        const msg = entry.message;
        if (!msg?.content) continue;

        // 提取文本内容
        const textParts: string[] = [];
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }

        const content = textParts.join('\n');
        if (!content.trim()) continue;

        messages.push({
          uuid: entry.uuid,
          role: 'assistant',
          content,
          timestamp: entry.timestamp || '',
          model: msg.model,
          usage: msg.usage ? {
            inputTokens: msg.usage.input_tokens || 0,
            outputTokens: msg.usage.output_tokens || 0,
          } : undefined,
        });
      }
    } catch {
      // 跳过无法解析的行
    }
  }

  return messages;
}
