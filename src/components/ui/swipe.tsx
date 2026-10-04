'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/shell/icon'
import type { IconName } from '@/components/shell/icons'
import { axisOf, damp, release, REST_PX, UNDO_MS } from '@/lib/swipe-gesture'

/**
 * Swipe actions on a mobile list row — docs/13 §4, "swipe right = primary, left = secondary,
 * always with Undo", and docs/68 §3 for why the Undo had to be built before the gesture.
 *
 * 🔴 Nothing is sent while the Undo is on screen. A swipe arms the action and the row says
 * what it is about to do; the request only leaves the device when the window closes. That is
 * the difference between an Undo and a compensating entry, and in this system there is no
 * such thing as a compensating entry you can hide — rule 2, nothing financial is deleted, so
 * an "undo" that posted a reversal would leave two entries in the ledger and lie about it.
 *
 * 🔴 The failure direction is "nothing happened". If the tab dies mid-window the request was
 * never made and the row is still on the list for somebody to deal with. Every `commit`
 * action must be chosen so that losing it is safe in exactly that way: it may leave work
 * undone, never work half-done.
 */

export type SwipeTone = 'accent' | 'good' | 'warn' | 'critical' | 'info'

/**
 * Common to both kinds.
 *
 * 🔴 `label` is what fits in the panel the finger has opened, which at the fire threshold is
 * about sixty pixels of text. "Record a receipt" rendered as "Reco…". The legend above the
 * list is a line of prose and has room for the whole phrase, so the two are separate strings
 * rather than one that has to be bad in one place.
 */
interface SwipeBase {
  /** One or two words, for the panel under the finger. */
  label: string
  /** The phrase for the legend above the list. Defaults to `label`. */
  legend?: string
  icon: IconName
  tone: SwipeTone
}

/** Navigation. Needs no Undo of its own — nothing changed, and Back is the Undo. */
export interface SwipeLink extends SwipeBase {
  kind: 'link'
  href: string
}

/** A mutation, held behind the Undo window. */
export interface SwipeCommit extends SwipeBase {
  kind: 'commit'
  /**
   * What the row reads while the window is open.
   *
   * 🔴 Present tense, always. For those five seconds nothing has happened, so "Approved" is
   * a lie the person is being invited to accept — and if they take the Undo it was never
   * true at all. "Approving ADP/26-27/0031" is both honest and clearer about what the Undo
   * is for.
   *
   * 🔴 And it cannot name what the action will produce. A draft invoice has no number until
   * the send allocates one (docs/64), so this says who it is going to, not a number that
   * does not exist yet and that another send may take first.
   */
  done: string
  /** A bound server action. Resolves to an error message rather than throwing it. */
  run: () => Promise<{ error?: string } | void>
}

export type SwipeIntent = SwipeLink | SwipeCommit
export interface SwipeSpec { right?: SwipeIntent; left?: SwipeIntent }


/**
 * One armed commit at a time, so a second swipe settles the first rather than racing it.
 * A pending commit is also flushed when the page is hidden: the person has moved on, and
 * holding a request behind a timer in a backgrounded tab is how it gets lost.
 */
let pendingFlush: (() => void) | null = null
function arm(flush: () => void) {
  pendingFlush?.()
  pendingFlush = flush
}
function disarm(flush: () => void) {
  if (pendingFlush === flush) pendingFlush = null
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pendingFlush?.()
  })
}

const TONE: Record<SwipeTone, { bg: string; fg: string }> = {
  accent: { bg: 'var(--accent)', fg: '#fff' },
  good: { bg: 'var(--good)', fg: '#fff' },
  warn: { bg: 'var(--warn)', fg: '#fff' },
  critical: { bg: 'var(--critical)', fg: '#fff' },
  info: { bg: 'var(--info)', fg: '#fff' },
}

export function SwipeRow({ spec, children, card }: {
  spec: SwipeSpec
  children: React.ReactNode
  /** The child draws its own surface (a `Card`), so this must not draw one behind it. */
  card?: boolean
}) {
  const router = useRouter()
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [armed, setArmed] = useState<SwipeCommit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const axis = useRef<'none' | 'x' | 'y'>('none')
  /** Set when a drag happened, so the click the browser synthesises afterwards is swallowed. */
  const dragged = useRef(false)
  /**
   * 🔴 The live offset, which the release reads instead of `dx`.
   *
   * `dx` is state, and state is what the LAST RENDER saw. React batches updates within a
   * task, so when the final `pointermove` and the `pointerup` arrive together — a flick, a
   * coalesced pair, a dropped frame — the release handler still sees the offset from before
   * the drag and decides the gesture never passed the threshold. It then resets, silently,
   * and the swipe does nothing at all. Found by driving the real thing; it does not reproduce
   * when the events are far enough apart to render in between, which is most of the time.
   */
  const offset = useRef(0)

  const reset = () => { offset.current = 0; setDx(0); setDragging(false); axis.current = 'none'; start.current = null }

  function fire(intent: SwipeIntent) {
    reset()
    if (intent.kind === 'link') { router.push(intent.href); return }
    setArmed(intent)
  }

  /* the Undo window: a timer, and the two ways it can end */
  useEffect(() => {
    if (!armed) return
    let cancelled = false
    const commit = () => {
      if (cancelled) return
      cancelled = true
      clearTimeout(timer)
      disarm(commit)
      void armed.run().then((r) => {
        if (r && 'error' in r && r.error) { setError(r.error); setArmed(null) }
        else { setArmed(null); router.refresh() }
      }).catch(() => { setError('That did not go through. Nothing was changed.'); setArmed(null) })
    }
    const timer = setTimeout(commit, UNDO_MS)
    arm(commit)
    return () => { cancelled = true; clearTimeout(timer); disarm(commit) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed])

  if (armed) {
    const tone = TONE[armed.tone]
    return (
      <div className={`relative flex items-center justify-between gap-3 overflow-hidden px-4 py-3.5 ${card ? 'rounded-xl border' : ''}`}
           style={{ background: 'var(--surface-2)', borderColor: 'var(--rule)' }}>
        <span className="flex min-w-0 items-center gap-2.5 text-[13px]">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full" style={{ background: tone.bg, color: tone.fg }}>
            <Icon name={armed.icon} size={13} strokeWidth={2.4} />
          </span>
          <span className="truncate">{armed.done}</span>
        </span>
        <button type="button" onClick={() => setArmed(null)}
          className="shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold"
          style={{ background: 'var(--surface-3)', color: 'var(--text-primary)' }}>
          <span className="flex items-center gap-1.5"><Icon name="Undo2" size={13} strokeWidth={2.2} />Undo</span>
        </button>
        {/* 🔴 How long is left, drawn rather than described. Without it the banner is a thing
            that appeared and will disappear, and the Undo reads as optional rather than timed. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left"
          style={{ background: tone.bg, animation: `adp-swipe-drain ${UNDO_MS}ms linear forwards` }} />
      </div>
    )
  }

  const revealed = dx > 0 ? spec.right : dx < 0 ? spec.left : undefined
  const tone = revealed ? TONE[revealed.tone] : null

  return (
    <div className={`relative overflow-hidden ${card ? 'rounded-xl' : ''}`} style={{ background: tone?.bg ?? 'transparent' }}>
      {/* 🔴 Stacked, not side by side. The panel is only as wide as the finger has pulled,
          and "Receipt" beside a 15px icon with any padding at all came out "Recei…". */}
      {revealed && (
        <button type="button" aria-label={revealed.label}
          onClick={() => fire(revealed)}
          className={`absolute inset-y-0 flex flex-col items-center justify-center gap-1 px-2 text-[11px] font-semibold ${dx > 0 ? 'left-0' : 'right-0'}`}
          style={{ color: tone!.fg, width: Math.abs(dx) }}>
          <Icon name={revealed.icon} size={16} strokeWidth={2.2} />
          {Math.abs(dx) > REST_PX && <span className="max-w-full truncate">{revealed.label}</span>}
        </button>
      )}
      <div
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 160ms ease-out',
          background: card ? 'transparent' : 'var(--surface-1)',
          touchAction: 'pan-y',
        }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return   // desktop has the table and its buttons
          if (!spec.right && !spec.left) return
          start.current = { x: e.clientX, y: e.clientY }
          axis.current = 'none'
          dragged.current = false
        }}
        onPointerMove={(e) => {
          if (!start.current) return
          const mx = e.clientX - start.current.x
          const my = e.clientY - start.current.y
          if (axis.current === 'none') {
            const a = axisOf(mx, my)
            if (a === 'y') { axis.current = 'y'; start.current = null; return }
            if (a === 'none') return
            axis.current = 'x'
            setDragging(true)
            dragged.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
          }
          const dir = mx > 0 ? spec.right : spec.left
          if (!dir) { offset.current = 0; setDx(0); return }
          offset.current = damp(mx)
          setDx(offset.current)
        }}
        onPointerUp={() => {
          const d = offset.current
          if (axis.current !== 'x') { reset(); return }
          switch (release(d, spec)) {
            case 'fire': { fire((d > 0 ? spec.right : spec.left)!); return }
            case 'rest': { offset.current = Math.sign(d) * REST_PX; setDx(offset.current); setDragging(false); return }
            default: reset()
          }
        }}
        onPointerCancel={reset}
        /* 🔴 the card is usually wrapped in a link; a drag must not also open the row */
        onClickCapture={(e) => { if (dragged.current) { e.preventDefault(); e.stopPropagation(); dragged.current = false } }}
      >
        {children}
      </div>
      {error && (
        <p className="px-4 pb-2.5 text-[11.5px]" style={{ color: 'var(--critical)' }}>{error}</p>
      )}
    </div>
  )
}
