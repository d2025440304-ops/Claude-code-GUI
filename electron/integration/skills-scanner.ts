/**
 * Skills 扫描器 — 读取用户级 (~/.claude/skills) 与项目级 (.claude/skills)
 * 目录中的 SKILL.md，解析 frontmatter，供设置面板展示与开关控制。
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

export interface SkillInfo {
  name: string;
  description: string;
  source: 'user' | 'project';
  path: string;
}

/** 解析 SKILL.md 的 YAML frontmatter（只取 name / description，足够 UI 展示）。 */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (kv) fm[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { name: fm.name, description: fm.description };
}

/**
 * 扫描全部 skill 目录。
 * @param projectPaths 要扫描的项目级 .claude/skills 的根目录列表
 */
export function scanSkills(projectPaths: string[]): SkillInfo[] {
  const dirs: { root: string; source: 'user' | 'project' }[] = [
    { root: path.join(homedir(), '.claude', 'skills'), source: 'user' },
    ...projectPaths
      .filter((p) => !!p)
      .map((p) => ({ root: path.join(p, '.claude', 'skills'), source: 'project' as const })),
  ];

  const result: SkillInfo[] = [];
  const seen = new Set<string>();

  for (const { root, source } of dirs) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(root, entry.name);
      const mdPath = path.join(skillDir, 'SKILL.md');
      if (!existsSync(mdPath)) continue;
      let content: string;
      try {
        content = readFileSync(mdPath, 'utf-8');
      } catch {
        continue;
      }
      const { name, description } = parseFrontmatter(content);
      const skillName = name || entry.name;
      // 同一名字的 skill：user 级优先展示，避免项目级重复
      if (seen.has(skillName)) continue;
      seen.add(skillName);
      result.push({
        name: skillName,
        description: description || '',
        source,
        path: skillDir,
      });
    }
  }
  return result;
}
