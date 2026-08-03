/**
 * 附件工具与共享组件 — Chat 模式与 Agent 模式共用。
 *
 * 从 ChatView.tsx 提取，避免两处重复实现粘贴/拖放/预览逻辑。
 */
import { memo, useCallback, useState } from 'react'
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react'
import { FileCode, X } from 'lucide-react'
import type { Attachment } from '../types'
import { ipc } from './ipc'

/* ---------- helpers ---------- */

export function basename(p: string): string {
  return p.split('/').pop() || p
}

/** Approximate byte size of a base64 data URL payload. */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
}

export function nextAttachId(): string {
  return `att-${crypto.randomUUID()}`
}

/** Read a File object (clipboard paste / drag & drop) into a data URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/* ---------- AttachmentPreview ---------- */

export const AttachmentPreview = memo(function AttachmentPreview({
  att,
  onRemove,
}: {
  att: Attachment
  onRemove: (id: string) => void
}) {
  if (att.kind === 'image' && att.dataUrl) {
    return (
      <div className="relative group" style={{ animation: 'fadeIn 150ms ease' }}>
        <img
          src={att.dataUrl}
          alt={att.name}
          className="rounded-lg object-cover"
          style={{ width: 56, height: 56, border: '1px solid var(--border-default)' }}
        />
        <button
          onClick={() => onRemove(att.id)}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center"
          style={{ background: 'var(--bg-surface-3)', color: 'var(--fg-secondary)' }}
          title="Remove"
        >
          <X size={9} strokeWidth={2.5} />
        </button>
      </div>
    )
  }
  // file chip
  return (
    <div
      className="flex items-center gap-1.5 rounded-lg pl-2 pr-1 py-1 animate-fade-in"
      style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-default)', maxWidth: '220px' }}
    >
      <FileCode size={12} className="flex-shrink-0 text-[var(--accent-bright)]" />
      <span className="text-[11px] truncate" style={{ color: 'var(--fg-secondary)' }}>{att.name}</span>
      <button
        onClick={() => onRemove(att.id)}
        className="flex-shrink-0 p-0.5 rounded hover:bg-[var(--tint-hover)]"
        title="Remove"
      >
        <X size={10} className="text-[var(--fg-tertiary)]" />
      </button>
    </div>
  )
})

/* ---------- hooks: shared attachment state logic ---------- */

export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)

  const addAttachment = useCallback((att: Attachment) => {
    setAttachments((prev) => [...prev, att])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const clearAttachments = useCallback(() => setAttachments([]), [])

  const addImageFromDataUrl = useCallback((dataUrl: string, name: string, mimeType: string, size: number) => {
    addAttachment({
      id: nextAttachId(), kind: 'image', name, size: size || dataUrlByteSize(dataUrl),
      mimeType, dataUrl,
    })
  }, [addAttachment])

  const addFilePath = useCallback((filePath: string) => {
    addAttachment({
      id: nextAttachId(), kind: 'file', name: basename(filePath), size: 0, path: filePath,
    })
  }, [addAttachment])

  // Upload files via native dialog (returns absolute paths).
  const handleAddFiles = useCallback(async () => {
    try {
      const res = await ipc.invoke<{ canceled: boolean; filePaths: string[] }>('attachment:open-files', { imagesOnly: false })
      if (!res.canceled) res.filePaths.forEach(addFilePath)
    } catch (e) { console.error('Failed to open files:', e) }
  }, [addFilePath])

  // Upload images via native dialog -> read as base64 data URL.
  const handleAddImages = useCallback(async () => {
    try {
      const res = await ipc.invoke<{ canceled: boolean; filePaths: string[] }>('attachment:open-files', { imagesOnly: true })
      if (res.canceled) return
      for (const fp of res.filePaths) {
        const r = await ipc.invoke<{ dataUrl: string; mimeType: string } | null>('attachment:read-data-url', { filePath: fp })
        if (r) addImageFromDataUrl(r.dataUrl, basename(fp), r.mimeType, 0)
      }
    } catch (e) { console.error('Failed to open images:', e) }
  }, [addImageFromDataUrl])

  // Paste: images (clipboard screenshot) -> data URL; files (Finder copy) -> paths.
  const handlePaste = useCallback(async (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const arr = Array.from(items as unknown as DataTransferItem[])
    const imageItems = arr.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    if (imageItems.length > 0) {
      e.preventDefault()
      for (const it of imageItems) {
        const file = it.getAsFile()
        if (!file) continue
        try {
          const dataUrl = await readFileAsDataUrl(file)
          addImageFromDataUrl(dataUrl, file.name || 'pasted-image.png', file.type, file.size)
        } catch (err) { console.error('Failed to read pasted image:', err) }
      }
      return
    }
    // Non-image file paste (e.g. file copied in Finder): resolve paths via main.
    const hasFile = arr.some((it) => it.kind === 'file')
    if (hasFile) {
      e.preventDefault()
      try {
        const paths = await ipc.invoke<string[]>('attachment:clipboard-files')
        paths.forEach(addFilePath)
      } catch (err) { console.error('Failed to read clipboard files:', err) }
    }
  }, [addImageFromDataUrl, addFilePath])

  // Drag-and-drop: images read as data URL; other files resolved to paths.
  const handleDrop = useCallback(async (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from((e.dataTransfer?.files ?? []) as unknown as File[])
    if (files.length === 0) return
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        try {
          const dataUrl = await readFileAsDataUrl(file)
          addImageFromDataUrl(dataUrl, file.name || 'dropped-image.png', file.type, file.size)
        } catch (err) { console.error('Failed to read dropped image:', err) }
      } else {
        // Electron exposes the absolute path on dropped File objects.
        const fp = (file as File & { path?: string }).path
        if (fp) addFilePath(fp)
      }
    }
  }, [addImageFromDataUrl, addFilePath])

  return {
    attachments,
    dragOver,
    setDragOver,
    addAttachment,
    removeAttachment,
    clearAttachments,
    addImageFromDataUrl,
    addFilePath,
    handleAddFiles,
    handleAddImages,
    handlePaste,
    handleDrop,
  }
}
