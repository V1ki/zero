interface TraitPillProps {
  trait: string
  active?: boolean
  interactive?: boolean
  onClick?: () => void
}

export function TraitPill({ trait, active = false, interactive = false, onClick }: TraitPillProps) {
  const className = `px-2 py-0.5 rounded text-[11px] border transition-colors ${
    active
      ? 'border-[var(--color-accent)] bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
      : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
  } ${interactive ? 'hover:text-[var(--color-text-primary)] hover:border-[var(--color-border-hover)]' : ''}`

  if (interactive) {
    return (
      <button type="button" className={className} onClick={onClick}>
        {trait}
      </button>
    )
  }

  return <span className={className}>{trait}</span>
}
