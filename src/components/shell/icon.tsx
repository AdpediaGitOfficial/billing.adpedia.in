'use client'
import { ICONS, type IconName } from './icons'
import type { LucideProps } from 'lucide-react'

/**
 * Name-addressed icon over the registry in `./icons`. `IconName` is a union, so a wrong name
 * does not compile — the `Circle` fallback only covers a name arriving from outside TypeScript,
 * and docs/68 §2 explains why the namespace import this replaced cost 150 kB a route.
 */
export function Icon({ name, ...props }: { name: IconName } & LucideProps) {
  const C = ICONS[name] ?? ICONS.Circle
  return <C {...props} />
}

export type { IconName }
