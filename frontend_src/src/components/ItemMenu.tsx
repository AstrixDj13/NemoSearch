import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface ItemMenuAction {
  label: string
  icon: LucideIcon
  onSelect: () => void
  separated?: boolean
}

interface ItemMenuProps {
  label: string
  actions: ItemMenuAction[]
}

// Compact overflow menu following the WAI-ARIA menu button pattern.
// The menu renders in a portal at a fixed position so scrolling lists and drawers never clip it.
export default function ItemMenu({ label, actions }: ItemMenuProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false)
    }
    // A fixed menu would drift away from its row, so close it when anything scrolls or resizes
    const onMove = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  const toggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const right = window.innerWidth - rect.right
      // Open upwards when the item sits near the bottom of the viewport
      setPosition(
        window.innerHeight - rect.bottom < 200 ? { bottom: window.innerHeight - rect.top + 4, right } : { top: rect.bottom + 4, right }
      )
    }
    setOpen(!open)
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus()
    if (event.key === 'ArrowDown') focusAt(index + 1)
    else if (event.key === 'ArrowUp') focusAt(index - 1)
    else if (event.key === 'Home') focusAt(0)
    else if (event.key === 'End') focusAt(items.length - 1)
    else if (event.key === 'Escape') {
      setOpen(false)
      triggerRef.current?.focus()
    } else if (event.key === 'Tab') setOpen(false)
    else return
    if (event.key !== 'Tab') event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className={`item-menu-wrap ${open ? 'open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="item-menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreHorizontal size={16} />
      </button>
      {open &&
        createPortal(
          <div ref={menuRef} role="menu" aria-label={label} className="item-menu" style={position} onKeyDown={onMenuKeyDown}>
            {actions.map(({ label: actionLabel, icon: Icon, onSelect, separated }) => (
              <button
                key={actionLabel}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={separated ? 'separated' : ''}
                onClick={() => {
                  setOpen(false)
                  onSelect()
                }}
              >
                <Icon size={14} aria-hidden="true" />
                {actionLabel}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
