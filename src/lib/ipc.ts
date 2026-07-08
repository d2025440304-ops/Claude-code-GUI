declare global {
  interface Window {
    claudeAPI: {
      invoke: <T = unknown>(channel: string, payload?: unknown) => Promise<T>
      on: (channel: string, cb: (data: any) => void) => () => void
    }
  }
}

export const ipc = {
  invoke: <T = unknown>(channel: string, payload?: unknown) => window.claudeAPI.invoke<T>(channel, payload),
  on: (channel: string, cb: (data: any) => void) => window.claudeAPI.on(channel, cb),
}
