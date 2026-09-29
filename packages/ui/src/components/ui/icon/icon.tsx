import * as React from 'react'
import { icons, type LucideProps } from 'lucide-react'
import { cn } from '../../../lib/utils'

/**
 * Lucide is the AuraOS default icon set. This wrapper resolves icons by
 * their kebab-case Lucide id (https://lucide.dev/icons) so callers don't
 * import individual icon components:
 *
 *   <Icon name="settings" />
 *   <Icon name="rotate-cw" size={20} className="text-[var(--aura-color-danger)]" />
 *
 * Icons stroke `currentColor`, so they follow the themed text color. For
 * tree-shaken direct imports, use `lucide-react` yourself — this dynamic
 * lookup bundles the full icon map. Unknown names render nothing (with a
 * dev-console warning) rather than crashing the tree.
 */
export interface IconProps extends Omit<LucideProps, 'ref'> {
  /** Lucide icon name, kebab-case (e.g. "rotate-cw") or PascalCase. */
  name: string
}

function toPascal(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function Icon({ name, className, size = '1em', ...props }: IconProps) {
  const LucideIcon = (icons as Record<string, React.ComponentType<LucideProps>>)[toPascal(name)]
  if (!LucideIcon) {
    console.warn(`[@aura/ui] unknown lucide icon: ${name}`)
    return null
  }
  return (
    <LucideIcon
      className={cn('inline-block align-[-0.125em]', className)}
      size={size}
      aria-hidden="true"
      {...props}
    />
  )
}

export { Icon }
