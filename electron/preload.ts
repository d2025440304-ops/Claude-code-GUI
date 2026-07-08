/**
 * Preload script - runs in an isolated context between the main process and
 * the renderer. Exposes a safe, minimal `claudeAPI` global on `window`.
 *
 * Security:
 *   - contextIsolation: true  (renderer cannot touch Node.js directly)
 *   - nodeIntegration: false (no require in renderer)
 *   - sandbox: false          (preload itself can require local modules)
 *
 * Channel validation: every `invoke()`/`on()` call is checked against the
 * whitelists in channels.ts, so a compromised renderer cannot register
 * arbitrary listeners or invoke unregistered handlers.
 *
 * The API surface is intentionally tiny:
 *   - invoke(channel, payload?)  -> promise-based request/reply to main
 *   - on(channel, cb)            -> subscribe to push events; returns disposer
 *   - channels                   -> all valid channel name constants
 */
import { contextBridge, ipcRenderer } from 'electron';
import { Channels, PUSH_CHANNELS } from './ipc/channels';

/** Every registered invoke/handle channel name. */
const INVOKE_CHANNELS: ReadonlySet<string> = new Set(
  Object.values(Channels).filter((c) => !PUSH_CHANNELS.has(c)),
);

contextBridge.exposeInMainWorld('claudeAPI', {
  /**
   * Invoke an IPC handler in the main process and await its response.
   * Rejects push channels (those are main -> renderer only).
   */
  invoke: (channel: string, payload?: unknown): Promise<unknown> => {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(
        new Error(`Blocked invoke on non-whitelisted channel: ${channel}`),
      );
    }
    return ipcRenderer.invoke(channel, payload);
  },

  /**
   * Subscribe to a push channel (main -> renderer).
   * Returns a disposer function that removes the listener.
   * Only push channels may be subscribed to.
   */
  on: (channel: string, cb: (data: any) => void): (() => void) => {
    if (!PUSH_CHANNELS.has(channel)) {
      console.warn(`Blocked subscription to non-push channel: ${channel}`);
      return (): void => {};
    }
    const handler = (_e: unknown, data: any): void => cb(data);
    ipcRenderer.on(channel, handler);
    return (): void => {
      ipcRenderer.removeListener(channel, handler);
    };
  },

  /** All valid IPC channel names, mirroring electron/ipc/channels.ts. */
  channels: { ...Channels },
});
