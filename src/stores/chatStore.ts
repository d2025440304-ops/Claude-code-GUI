import { create } from 'zustand'
import type { Conversation, Message } from '../types'

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: Record<string, Message[]>
  selectedModel: string
  permissionMode: string
  thinkingEffort: string
  streamingConversations: Set<string>

  setConversations: (conversations: Conversation[]) => void
  setActiveConversation: (id: string | null) => void
  addConversation: (conversation: Conversation) => void
  updateConversation: (id: string, updates: Partial<Conversation>) => void
  removeConversation: (id: string) => void
  setMessages: (conversationId: string, messages: Message[]) => void
  addMessage: (conversationId: string, message: Message) => void
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void
  setSelectedModel: (model: string) => void
  setPermissionMode: (mode: string) => void
  setThinkingEffort: (effort: string) => void
  setStreaming: (conversationId: string, streaming: boolean) => void
}

export const useChatStore = create<ChatState>((set) => ({
  conversations: [],
  activeConversationId: null,
  messages: {},
  selectedModel: 'default',
  permissionMode: 'ask',
  thinkingEffort: 'medium',
  streamingConversations: new Set(),

  setConversations: (conversations) => set({ conversations }),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  addConversation: (conversation) => set((s) => ({
    conversations: [conversation, ...s.conversations],
    activeConversationId: conversation.id,
  })),
  updateConversation: (id, updates) => set((s) => ({
    conversations: s.conversations.map((c) => c.id === id ? { ...c, ...updates } : c),
  })),
  removeConversation: (id) => set((s) => {
    const remaining = s.conversations.filter((c) => c.id !== id)
    const nextActive = s.activeConversationId === id
      ? (remaining[0]?.id ?? null)
      : s.activeConversationId
    return { conversations: remaining, activeConversationId: nextActive }
  }),
  setMessages: (conversationId, messages) => set((s) => ({
    messages: { ...s.messages, [conversationId]: messages },
  })),
  addMessage: (conversationId, message) => set((s) => ({
    messages: {
      ...s.messages,
      [conversationId]: [...(s.messages[conversationId] ?? []), message],
    },
  })),
  updateMessage: (conversationId, messageId, updates) => set((s) => ({
    messages: {
      ...s.messages,
      [conversationId]: (s.messages[conversationId] ?? []).map((m) =>
        m.id === messageId ? { ...m, ...updates } : m
      ),
    },
  })),
  setSelectedModel: (model) => set({ selectedModel: model }),
  setPermissionMode: (mode) => set({ permissionMode: mode }),
  setThinkingEffort: (effort) => set({ thinkingEffort: effort }),
  setStreaming: (conversationId, streaming) => set((s) => {
    const next = new Set(s.streamingConversations)
    if (streaming) next.add(conversationId)
    else next.delete(conversationId)
    return { streamingConversations: next }
  }),
}))
