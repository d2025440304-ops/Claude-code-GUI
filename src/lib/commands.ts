/**
 * Shared slash command definitions for ChatView and AgentChatInput.
 * Single source of truth — edit here, both components pick it up.
 */

import {
  ArrowUp, FileCode, Zap, Trash2, Plus, HelpCircle, Cpu,
  Settings, Shield, Terminal,
} from 'lucide-react'

import type { ModelOption } from '../types'

export interface SlashCommand {
  id: string
  label: string
  description: string
  icon: typeof Zap
  shortcut?: string
}

/**
 * Build the full slash command list.
 * `currentModel` and `models` are only needed to populate the "Switch Model" description.
 */
export function buildSlashCommands(models?: ModelOption[], currentModel?: string): SlashCommand[] {
  return [
    // ── Core ──
    { id: 'model', label: 'Switch Model', description: `Current: ${models?.find(m => m.id === currentModel)?.name || 'Default'}`, icon: Cpu, shortcut: '⌘M' },
    { id: 'new', label: 'New Chat', description: 'Start a new conversation', icon: Plus, shortcut: '⌘N' },
    { id: 'clear', label: 'Clear History', description: 'Remove all messages', icon: Trash2 },
    { id: 'compact', label: 'Compact Context', description: 'Compress conversation to save tokens', icon: Zap },
    { id: 'cost', label: 'Token Usage', description: 'Show token usage and cost', icon: Zap },
    { id: 'fast', label: 'Fast Mode', description: 'Toggle fast mode (Opus accelerated output)', icon: Zap },
    { id: 'continue', label: 'Continue Chat', description: 'Continue the most recent conversation', icon: ArrowUp },

    // ── Session management ──
    { id: 'help', label: 'Help & Shortcuts', description: 'Show available commands', icon: HelpCircle },
    { id: 'config', label: 'Configuration', description: 'View or modify Claude Code settings', icon: Settings },
    { id: 'login', label: 'Login', description: 'Sign in to your Anthropic account', icon: HelpCircle },
    { id: 'logout', label: 'Logout', description: 'Sign out', icon: HelpCircle },
    { id: 'doctor', label: 'Diagnostics', description: 'Diagnose configuration issues', icon: HelpCircle },
    { id: 'permissions', label: 'Permissions', description: 'Manage tool permissions', icon: Shield },

    // ── Code & Project ──
    { id: 'init', label: 'Init Project', description: 'Initialize CLAUDE.md for this project', icon: FileCode },
    { id: 'review', label: 'Review PR', description: 'Review the current pull request', icon: FileCode },
    { id: 'pr-comments', label: 'PR Comments', description: 'View comments on the current PR', icon: FileCode },
    { id: 'memory', label: 'Edit Memory', description: 'Edit memory files (CLAUDE.md)', icon: FileCode },

    // ── Terminal & Integration ──
    { id: 'terminal-setup', label: 'Terminal Setup', description: 'Configure terminal integration', icon: Terminal },
    { id: 'vim', label: 'Vim Mode', description: 'Toggle vim keybindings', icon: HelpCircle },
    { id: 'mcp', label: 'MCP Servers', description: 'Manage MCP server connections', icon: HelpCircle },

    // ── Expert commands ──
    { id: 'deep-research', label: 'Deep Research', description: 'Multi-source research with fact-checking', icon: Zap },
    { id: 'code-review', label: 'Code Review', description: 'Review code changes (--comment, --fix)', icon: FileCode },
    { id: 'simplify', label: 'Simplify & Fix', description: 'Review and auto-fix code', icon: Zap },
    { id: 'verify', label: 'Verify Changes', description: 'Verify code changes work as expected', icon: Zap },
    { id: 'security-review', label: 'Security Review', description: 'Security review of pending changes', icon: Shield },
    { id: 'update-config', label: 'Update Config', description: 'Configure settings.json', icon: Settings },
    { id: 'loop', label: 'Loop Command', description: 'Run a command on interval', icon: Zap },
    { id: 'run', label: 'Run App', description: 'Launch and drive the project app', icon: Zap },
  ]
}