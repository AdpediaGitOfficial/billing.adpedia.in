/**
 * The swipe gesture's arithmetic, kept pure — docs/68 §3.
 *
 * The component around it is pointer plumbing and React state; these are the decisions, and
 * they are the part that can be wrong in a way nobody notices. They live here so they can be
 * tested without a DOM, which this suite does not have.
 */

/** Below this a movement is not yet a drag, and a vertical scroll still wins. */
export const SLOP_PX = 12
/** Past this the gesture fires on release. */
export const FIRE_PX = 96
/** Past this it rests open, so the action can also simply be tapped. */
export const REST_PX = 64
/** How long the Undo stays. Long enough to read the row, short enough not to be forgotten. */
export const UNDO_MS = 5_000

export type Axis = 'none' | 'x' | 'y'

/**
 * Which way the finger has committed.
 *
 * 🔴 Vertical wins ties and wins early. A list is for scrolling; a gesture that steals an
 * ambiguous movement makes the list feel broken, and the cost of being slow to claim a
 * horizontal drag is only that the first few pixels do not follow the finger.
 */
export function axisOf(mx: number, my: number): Axis {
  if (Math.abs(my) > SLOP_PX && Math.abs(my) >= Math.abs(mx)) return 'y'
  if (Math.abs(mx) >= SLOP_PX) return 'x'
  return 'none'
}

/**
 * How far the row moves for a finger that has travelled `mx`.
 *
 * Past the fire point it stops following, so the threshold can be felt rather than guessed at.
 */
export function damp(mx: number): number {
  const over = Math.max(0, Math.abs(mx) - FIRE_PX)
  return Math.sign(mx) * (Math.abs(mx) - over * 0.7)
}

/**
 * What a release at `offset` does, given which sides have an action.
 *
 * 🔴 `offset` is passed in rather than read from component state. React batches updates
 * within a task, so a flick whose last move and release arrive together would otherwise be
 * judged on the offset from before the drag — and silently do nothing.
 */
export function release(offset: number, has: { right?: unknown; left?: unknown }): 'fire' | 'rest' | 'reset' {
  const side = offset > 0 ? has.right : offset < 0 ? has.left : undefined
  if (!side) return 'reset'
  if (Math.abs(offset) >= FIRE_PX) return 'fire'
  if (Math.abs(offset) >= REST_PX) return 'rest'
  return 'reset'
}
