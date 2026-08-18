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
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

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

function defaultBookmarkName(t: TFunction, locale: string) {
  const now = new Date()
  const date = new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  return t('bookmarks.defaultName', { date })
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
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? i18n.language
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(() => defaultBookmarkName(t, locale))
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
      setName(defaultBookmarkName(t, locale))
      toast.success(t('bookmarks.toast.saved'))
    },
    onError: (error) => toast.error(t('bookmarks.toast.saveError', { message: errorMessage(error) })),
  })

  const renameMutation = useMutation({
    mutationFn: ({ id, nextName }: { id: string; nextName: string }) =>
      renameRegionBookmark(id, nextName),
    onSuccess: async () => {
      void trackTelemetry('bookmark_action', { action: 'renamed' })
      await queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY })
      setEditingId(null)
      setEditingName('')
      toast.success(t('bookmarks.toast.renamed'))
    },
    onError: (error) => toast.error(t('bookmarks.toast.renameError', { message: errorMessage(error) })),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteRegionBookmark,
    onSuccess: async () => {
      void trackTelemetry('bookmark_action', { action: 'deleted' })
      await queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY })
      setDeletingId(null)
      toast.success(t('bookmarks.toast.deleted'))
    },
    onError: (error) => toast.error(t('bookmarks.toast.deleteError', { message: errorMessage(error) })),
  })

  const totalCoordinates = useMemo(
    () => bookmarksQuery.data?.reduce((total, bookmark) => total + coordinateCount(bookmark), 0) ?? 0,
    [bookmarksQuery.data],
  )

  const handleSave = () => {
    if (!bounds) {
      toast.info(t('bookmarks.toast.chooseRange'))
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
        title={t('bookmarks.title')}
        onClick={() => {
          setName(defaultBookmarkName(t, locale))
          setOpen(true)
        }}
      >
        <Bookmark className="size-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[80vh] max-w-lg flex-col">
          <DialogHeader>
            <DialogTitle>{t('bookmarks.title')}</DialogTitle>
            <DialogDescription>
              {t('bookmarks.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-2">
            <Input
              value={name}
              maxLength={80}
              placeholder={t('bookmarks.placeholder')}
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
              {t('bookmarks.save')}
            </Button>
          </div>

          {!bounds && (
            <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {t('bookmarks.noSelection')}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
            {bookmarksQuery.isLoading ? (
              <div className="flex h-28 items-center justify-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : bookmarksQuery.isError ? (
              <div className="p-4 text-center text-sm text-destructive">
                {t('bookmarks.loadError', { message: errorMessage(bookmarksQuery.error) })}
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
                            title={t('bookmarks.renameConfirm')}
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
                            title={t('bookmarks.renameCancel')}
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
                                ? t('bookmarks.polygonSummary', {
                                    rings: bookmark.polygon.length,
                                    points: points.toLocaleString(locale),
                                  })
                                : t('bookmarks.boundsSummary')}
                            </div>
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            title={t('bookmarks.restore')}
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
                            title={t('bookmarks.rename')}
                            onClick={() => startRename(bookmark)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant={isDeleting ? 'destructive' : 'ghost'}
                            size="icon"
                            className="size-8"
                            title={t(isDeleting ? 'bookmarks.deleteConfirm' : 'bookmarks.delete')}
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
                          {t('bookmarks.deleteHint')}
                          <button type="button" className="underline" onClick={() => setDeletingId(null)}>
                            {t('bookmarks.cancel')}
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
                <span className="text-sm">{t('bookmarks.empty')}</span>
              </div>
            )}
          </div>

          {!!bookmarksQuery.data?.length && (
            <div className="text-right text-xs text-muted-foreground">
              {t('bookmarks.total', { count: bookmarksQuery.data.length })}
              {totalCoordinates > 0
                ? t('bookmarks.coordinateTotal', {
                    count: totalCoordinates.toLocaleString(locale),
                  })
                : ''}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
