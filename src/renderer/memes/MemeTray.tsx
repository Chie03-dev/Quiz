import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MemeInfo } from '../../shared/types'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { ConfirmButton } from '../components/ConfirmButton'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { Panel } from '../components/Panel'
import { compressImage } from './compress'

interface MemeTrayProps {
  /** The meme the per-student pop buttons use. */
  selectedId: string | null
  onSelect: (id: string) => void
  /** Called after the tray changed (an upload or a delete). */
  onChanged?: () => void
  /** Called after a pop, so the screen can show it to the instructor too. */
  onPop?: (memeId: string) => void
  /** A horizontal strip for the live screen instead of the full grid. */
  compact?: boolean
}

/**
 * The meme tray: the instructor's jumpscare images. One meme is selected at
 * a time; the per-student pop buttons pop that one, so the instructor picks
 * the ammo first and the victim second.
 */
export function MemeTray({
  selectedId,
  onSelect,
  onChanged,
  onPop,
  compact = false
}: MemeTrayProps): React.JSX.Element {  const [memes, setMemes] = useState<MemeInfo[] | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [fallbacks, setFallbacks] = useState<Record<string, string>>({})
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => {
    void window.quiz.listMemes().then(setMemes)
  }, [])
  useEffect(refresh, [refresh])

  // The seeded sample has no stored thumbnail, so it falls back to the full
  // image as a data URL.
  const missingThumbs = useMemo(
    () => memes?.filter((m) => !m.thumb).map((m) => m.id) ?? [],
    [memes]
  )
  const missingKey = missingThumbs.join(',')
  useEffect(() => {
    if (!missingKey) return
    for (const id of missingKey.split(',')) {
      void window.quiz.memeData(id).then((url) => {
        if (url) setFallbacks((prev) => (prev[id] ? prev : { ...prev, [id]: url }))
      })
    }
  }, [missingKey])

  const upload = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files ?? [])
    // Reset so the same file can be picked again.
    event.target.value = ''
    if (files.length === 0) return
    setBusy(true)
    const failures: string[] = []
    for (const file of files) {
      try {
        const compressed = await compressImage(file)
        const result = await window.quiz.saveMeme({
          name: file.name,
          mime: compressed.mime,
          width: compressed.width,
          height: compressed.height,
          bytes: compressed.bytes,
          thumb: compressed.thumb
        })
        if (!result.ok) failures.push(`${file.name}: ${result.error}`)
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    setErrors(failures)
    setBusy(false)
    refresh()
    onChanged?.()
  }

  const pop = (meme: MemeInfo): void => {
    void window.quiz.popMeme(meme.id).then((result) => {
      if (!result.ok) setErrors([result.error])
    })
    // Popping also picks the meme, so the per-student buttons use it too.
    onSelect(meme.id)
    onPop?.(meme.id)
  }

  const remove = (meme: MemeInfo): void => {
    void window.quiz.deleteMeme(meme.id).then(() => {
      if (selectedId === meme.id) onSelect('')
      refresh()
      onChanged?.()
    })
  }

  const items = memes ?? []

  return (
    <div className={`memes${compact ? ' memes--strip' : ''}`} data-testid="meme-panel">
      <Panel
        title="Memes"
        actions={
          <>
            <Badge tone="neutral">{items.length}</Badge>
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="upload" />}
              testId="meme-add"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? 'Adding…' : 'Add memes'}
            </Button>
          </>
        }
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="ui-sr-only"
          data-testid="meme-file-input"
          onChange={(e) => void upload(e)}
        />

        {errors.length > 0 && (
          <ul className="memes__errors">
            {errors.map((message) => (
              <li key={message} className="ui-error">
                {message}
              </li>
            ))}
          </ul>
        )}

        {memes === null ? (
          <EmptyState title="Loading…" />
        ) : items.length === 0 ? (
          <EmptyState
            title="No memes yet"
            body="Add an image and pop it onto the students' phones."
            icon={<Icon name="image" />}
          />
        ) : (
          <ul className="memes__grid">
            {items.map((meme) => {
              const selected = meme.id === selectedId
              return (
                <li
                  key={meme.id}
                  className={`memes__item${selected ? ' memes__item--on' : ''}`}
                  data-testid={`meme-${meme.id}`}
                >
                  <button
                    type="button"
                    className="memes__pick"
                    title={selected ? 'Selected meme' : 'Select this meme'}
                    data-testid={`meme-pick-${meme.id}`}
                    onClick={() => onSelect(meme.id)}
                  >
                    <img
                      className="memes__thumb"
                      src={meme.thumb || fallbacks[meme.id] || ''}
                      alt={meme.name}
                    />
                    <span className="memes__name">{meme.name}</span>
                  </button>
                  <span className="memes__actions">
                    <Button
                      variant={selected ? 'primary' : 'secondary'}
                      size="sm"
                      icon={<Icon name="zap" />}
                      testId={`pop-${meme.id}`}
                      onClick={() => pop(meme)}
                    >
                      Pop
                    </Button>
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Yes, delete"
                      variant="ghost"
                      confirmVariant="danger"
                      size="sm"
                      testId={`delete-meme-${meme.id}`}
                      confirmTestId={`delete-meme-confirm-${meme.id}`}
                      onConfirm={() => remove(meme)}
                    />
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>
    </div>
  )
}
