import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bookmark,
  BookmarkPlus,
  Check,
  Loader2,
  MapPinned,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useSelectionStore } from '@/store/selection-store'
import { trackTelemetry } from '@/features/telemetry/telemetry-client'
import {
  createRegionBookmark,
  deleteRegionBookmark,
  listRegionBookmarks,
  renameRegionBookmark,
  type RegionBookmark,
} from './region-bookmarks-api'

const BOOKMARKS_QUERY_KEY = ['region-bookmarks'] as const

function defaultBookmarkName() {
  const now = new Date()
  const date = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  return `下载范围 ${date}`
}

function coordinateCount(bookmark: RegionBookmark) {
  return bookmark.polygon?.reduce((total, ring) => total + ring.length, 0) ?? 0
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

interface Props {
  onRestore: (bookmark: RegionBookmark) => void
}

export function RegionBookmarksDialog({ onRestore }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(defaultBookmarkName)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const bounds = useSelectionStore((state) => state.bounds)
  const polygon = useSelectionStore((state) => state.polygon)
  const queryClient = useQueryClient()

  const bookmarksQuery = useQuery({
    queryKey: BOOKMARKS_QUERY_KEY,
    queryFn: listRegionBookmarks,
    enabled: open,
  })

  const createMutation = useMutation({
    mutationFn: createRegionBookmark,
    onSuccess: async () => {
      void trackTelemetry('bookmark_action', { action: 'created' })
      await queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY })
      setName(defaultBookmarkName())
      toast.success('范围书签已保存')
    },
    onError: (error) => toast.error(`保存失败：${errorMessage(error)}`),
  })

  const renameMutation = useMutation({
    mutationFn: ({ id, nextName }: { id: string; nextName: string }) =>
      renameRegionBookmark(id, nextName),
    onSuccess: async () => {
      void trackTelemetry('bookmark_action', { action: 'renamed' })
      await queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY })
      setEditingId(null)
      setEditingName('')
      toast.success('书签已重命名')
    },
    onError: (error) => toast.error(`重命名失败：${errorMessage(error)}`),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteRegionBookmark,
    onSuccess: async () => {
      void trackTelemetry('bookmark_action', { action: 'deleted' })
      await queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY })
      setDeletingId(null)
      toast.success('书签已删除')
    },
    onError: (error) => toast.error(`删除失败：${errorMessage(error)}`),
  })

  const totalCoordinates = useMemo(
    () => bookmarksQuery.data?.reduce((total, bookmark) => total + coordinateCount(bookmark), 0) ?? 0,
    [bookmarksQuery.data],
  )

  const handleSave = () => {
    if (!bounds) {
      toast.info('请先选择下载范围')
      return
    }
    createMutation.mutate({ name, bounds, polygon })
  }

  const startRename = (bookmark: RegionBookmark) => {
    setDeletingId(null)
    setEditingId(bookmark.id)
    setEditingName(bookmark.name)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setEditingId(null)
      setDeletingId(null)
    }
  }

  return (
    <>
      <Button
        data-tour="region-bookmarks"
        type="button"
        variant="outline"
        size="icon"
        className="size-8"
        title="下载范围书签"
        onClick={() => {
          setName(defaultBookmarkName())
          setOpen(true)
        }}
      >
        <Bookmark className="size-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[80vh] max-w-lg flex-col">
          <DialogHeader>
            <DialogTitle>下载范围书签</DialogTitle>
            <DialogDescription>
              保存当前选区，之后可一键恢复。书签仅保存在本机。
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-2">
            <Input
              value={name}
              maxLength={80}
              placeholder="输入书签名称"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && bounds && name.trim()) handleSave()
              }}
            />
            <Button
              type="button"
              className="shrink-0"
              disabled={!bounds || !name.trim() || createMutation.isPending}
              onClick={handleSave}
            >
              {createMutation.isPending ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : (
                <BookmarkPlus className="mr-1.5 size-4" />
              )}
              保存当前范围
            </Button>
          </div>

          {!bounds && (
            <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              当前没有选区，仍可管理和恢复已有书签。
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
            {bookmarksQuery.isLoading ? (
              <div className="flex h-28 items-center justify-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : bookmarksQuery.isError ? (
              <div className="p-4 text-center text-sm text-destructive">
                加载失败：{errorMessage(bookmarksQuery.error)}
              </div>
            ) : bookmarksQuery.data?.length ? (
              <div className="divide-y">
                {bookmarksQuery.data.map((bookmark) => {
                  const points = coordinateCount(bookmark)
                  const isEditing = editingId === bookmark.id
                  const isDeleting = deletingId === bookmark.id
                  return (
                    <div key={bookmark.id} className="p-3">
                      {isEditing ? (
                        <div className="flex gap-1.5">
                          <Input
                            autoFocus
                            value={editingName}
                            maxLength={80}
                            onChange={(event) => setEditingName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && editingName.trim()) {
                                renameMutation.mutate({ id: bookmark.id, nextName: editingName })
                              }
                              if (event.key === 'Escape') setEditingId(null)
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="size-9"
                            title="确认重命名"
                            disabled={!editingName.trim() || renameMutation.isPending}
                            onClick={() =>
                              renameMutation.mutate({ id: bookmark.id, nextName: editingName })
                            }
                          >
                            {renameMutation.isPending ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Check className="size-4" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-9"
                            title="取消重命名"
                            onClick={() => setEditingId(null)}
                          >
                            <X className="size-4" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => {
                              onRestore(bookmark)
                              setOpen(false)
                            }}
                          >
                            <div className="truncate text-sm font-medium">{bookmark.name}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {bookmark.polygon?.length
                                ? `${bookmark.polygon.length} 个环 · ${points.toLocaleString()} 个坐标点`
                                : '矩形范围'}
                            </div>
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            title="恢复此范围"
                            onClick={() => {
                              onRestore(bookmark)
                              setOpen(false)
                            }}
                          >
                            <MapPinned className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            title="重命名"
                            onClick={() => startRename(bookmark)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant={isDeleting ? 'destructive' : 'ghost'}
                            size="icon"
                            className="size-8"
                            title={isDeleting ? '再次点击确认删除' : '删除'}
                            disabled={deleteMutation.isPending}
                            onClick={() => {
                              if (isDeleting) deleteMutation.mutate(bookmark.id)
                              else {
                                setEditingId(null)
                                setDeletingId(bookmark.id)
                              }
                            }}
                          >
                            {isDeleting && deleteMutation.isPending ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                          </Button>
                        </div>
                      )}
                      {isDeleting && !isEditing && (
                        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-destructive">
                          再次点击删除按钮确认
                          <button type="button" className="underline" onClick={() => setDeletingId(null)}>
                            取消
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex h-28 flex-col items-center justify-center gap-2 text-muted-foreground">
                <Bookmark className="size-5" />
                <span className="text-sm">还没有保存的范围</span>
              </div>
            )}
          </div>

          {!!bookmarksQuery.data?.length && (
            <div className="text-right text-xs text-muted-foreground">
              {bookmarksQuery.data.length} 个书签
              {totalCoordinates > 0 ? ` · ${totalCoordinates.toLocaleString()} 个坐标点` : ''}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
