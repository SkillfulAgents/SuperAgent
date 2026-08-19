import { ServiceIcon } from '@renderer/components/ui/service-icon'
import {
  connectionIconSlug,
  connectionLabel,
  getTemplateAccent,
  getTemplateIcon,
} from './template-meta'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

/**
 * Named chips for the services a template connects to. Only connections with a
 * real logo are shown — a chip bearing the generic fallback glyph carries no
 * information, and a row of identical fallbacks reads as broken.
 */
function ToolStack({ template }: { template: ApiDiscoverableAgent }) {
  const withLogos = (template.worksWith ?? [])
    .map((c) => ({ ...c, iconSlug: connectionIconSlug(c.slug) }))
    .filter((c) => c.iconSlug)
  if (withLogos.length === 0) return null
  // Named chips are far wider than the bare coins were, so only the first few
  // fit on one line — the rest collapse into a count.
  const shown = withLogos.slice(0, MAX_NAMED_CONNECTIONS)
  const overflow = withLogos.length - shown.length
  return (
    <span className="flex items-center gap-1.5">
      {shown.map((connection) => (
        <span
          key={`${connection.type}-${connection.slug}`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-card px-2 text-[11px] text-muted-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.07)]"
        >
          <ServiceIcon slug={connection.iconSlug} className="size-[15px]" />
          {connectionLabel(connection.slug)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          title={withLogos.slice(MAX_NAMED_CONNECTIONS).map((c) => connectionLabel(c.slug)).join(', ')}
          className="inline-flex h-7 shrink-0 items-center rounded-lg bg-card px-2 text-[11px] text-muted-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.07)]"
        >
          +{overflow}
        </span>
      )}
    </span>
  )
}

const MAX_NAMED_CONNECTIONS = 3

const AVATAR_SIZES = {
  md: { tile: 'size-14 rounded-[14px]', glyph: 'size-6' },
  lg: { tile: 'size-16 rounded-2xl', glyph: 'size-7' },
} as const

/** Template icon tile: the icon named by the skillset index, colored from the
 *  palette by template name, on a neutral grey square. The grey is `muted` at
 *  half strength — the extra headroom lifts every accent above the 3:1
 *  graphics threshold. The cards render the bare glyph instead; this tiled
 *  form heads the details page. */
export function TemplateAvatar({
  template,
  size = 'md',
}: {
  template: ApiDiscoverableAgent
  size?: keyof typeof AVATAR_SIZES
}) {
  const Icon = getTemplateIcon(template)
  const accent = getTemplateAccent(template.name)
  const { tile, glyph } = AVATAR_SIZES[size]
  return (
    <span
      className={`grid shrink-0 place-items-center bg-muted/50 shadow-[0_1px_2px_0_rgba(0,0,0,0.06)] ${tile}`}
    >
      <Icon className={`${accent} ${glyph}`} aria-hidden />
    </span>
  )
}

/**
 * Marketplace card for one agent template: the icon stacked above the name,
 * blurb, and the services it connects to. The whole card opens the details
 * page, which is where installing happens.
 */
export function ExploreTemplateCard({
  template,
  onOpen,
}: {
  template: ApiDiscoverableAgent
  onOpen: (template: ApiDiscoverableAgent) => void
}) {
  const Icon = getTemplateIcon(template)
  return (
    // Fixed 188px. A full two-line card needs ~175px (32px outer padding +
    // 40px title row + 12px gap + 8px description lead-in + 39px of
    // description + 8px gap + 36px chip row), so this leaves a little slack
    // rather than pinning the chips against the text. Every field is bounded —
    // the title truncates and the description clamps — so nothing outgrows it.
    <div
      data-testid="explore-template-card"
      className="relative flex h-[188px] flex-col items-start gap-3 rounded-3xl border border-black/[0.06] bg-card p-4 text-left transition-colors hover:border-black/15 dark:border-white/[0.06] dark:hover:border-white/15 hover:bg-accent/30"
    >
      <button
        type="button"
        onClick={() => onOpen(template)}
        aria-label={`${template.name} — details`}
        className="absolute inset-0 rounded-3xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <span className="flex w-full items-center gap-2">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted/50 shadow-[0_2px_6px_0_rgba(0,0,0,0.14)]">
          <Icon className={`size-6 ${getTemplateAccent(template.name)}`} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate pl-1 text-[13px] font-medium text-foreground">
          {template.name}
        </span>
      </span>

      <span className="flex min-w-0 w-full flex-1 flex-col gap-2">
        {/* No `block` here — it would override line-clamp's `-webkit-box`
            display and the clamp would silently never apply. */}
        <span className="line-clamp-2 pt-2 text-[13px] leading-normal text-muted-foreground/70">
          {template.description}
        </span>
        <span className="mt-auto flex items-center gap-2 overflow-hidden pt-2">
          <ToolStack template={template} />
        </span>
      </span>
    </div>
  )
}
