import { ArrowRight, Plus } from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { connectionLabel, getTemplateAccent, getTemplateIcon } from './template-meta'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

/**
 * Named chips for the services a template connects to. Every declared
 * connection is listed, logo or not: the chip carries the service's name, so
 * one falling back to a generic glyph still says what it connects to — and a
 * card that hides connections misrepresents what the template needs.
 */
function ToolStack({ template }: { template: ApiDiscoverableAgent }) {
  const connections = template.worksWith ?? []
  if (connections.length === 0) return null
  // Named chips are far wider than the bare coins were, so only the first few
  // fit on one line — the rest collapse into a count.
  const shown = connections.slice(0, MAX_NAMED_CONNECTIONS)
  const overflow = connections.length - shown.length
  return (
    <span className="flex items-center gap-0.5">
      {shown.map((connection) => (
        <span
          key={`${connection.type}-${connection.slug}`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-[11px] text-muted-foreground"
        >
          <ServiceIcon
            slug={connection.slug}
            fallback={connection.type === 'mcp' ? 'mcp' : 'oauth'}
            className="size-[15px] shrink-0"
          />
          {connectionLabel(connection.slug)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          title={connections.slice(MAX_NAMED_CONNECTIONS).map((c) => connectionLabel(c.slug)).join(', ')}
          className="inline-flex h-7 shrink-0 items-center rounded-lg px-1.5 text-[11px] text-muted-foreground"
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
      className={`grid shrink-0 place-items-center bg-muted/50 shadow-[0_2px_6px_0_rgba(0,0,0,0.14)] ${tile}`}
    >
      <Icon className={`${accent} ${glyph}`} aria-hidden />
    </span>
  )
}

/**
 * Marketplace card for one agent template: the icon stacked above the name,
 * blurb, and the services it connects to. On Explore the whole card opens the
 * details page, which is where installing happens; the wizard's roster wires
 * `onOpen` to an immediate install instead, so the accessible name has to say
 * which one a click actually does.
 */
export function ExploreTemplateCard({
  template,
  onOpen,
  action = 'details',
}: {
  template: ApiDiscoverableAgent
  onOpen: (template: ApiDiscoverableAgent) => void
  /** What clicking the card does, for the aria-label: "{name} — {action}". */
  action?: string
}) {
  const Icon = getTemplateIcon(template)
  return (
    // Three evenly spaced blocks, one 20px gap between each: the 40px title
    // row, a description that always reserves its two lines (39px) whether or
    // not it fills them, and the 28px chip row. That sums to exactly 179px of
    // content + 32px padding, so the height is fixed at 180 with no leftover
    // slack — no `mt-auto`, which is what made the gaps uneven before.
    //
    // The card IS the button rather than carrying an `absolute inset-0` overlay
    // one: a positioned overlay paints above the static content beneath it, so
    // the chip row's `title` never surfaced. Everything inside is a span, so it
    // nests legally.
    <button
      type="button"
      data-testid="explore-template-card"
      onClick={() => onOpen(template)}
      aria-label={`${template.name} — ${action}`}
      // 200ms: hover is feedback, not an animation. The lift is 2px, so a
      // longer curve spends its tail finishing a sub-pixel move that already
      // looks arrived — which reads as lag. Matches the renderer's dominant
      // duration and the see-more tile beside it.
      className={`flex h-[180px] w-full flex-col items-start gap-5 rounded-2xl border border-black/[0.06] bg-card p-4 text-left shadow-none transition-[box-shadow,transform] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_8px_20px_-6px_rgba(0,0,0,0.16)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-white/[0.06] dark:hover:shadow-[0_8px_20px_-6px_rgba(0,0,0,0.5)]`}
    >
      <span className="flex w-full items-center gap-2">
        {/* The glyph is debossed — it drops a 1px light highlight beneath its
            strokes, the bevel your eye reads as "carved in". Dark mode flips
            the highlight to a shadow, since white would read as embossed. */}
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted/50 shadow-[0_2px_6px_0_rgba(0,0,0,0.14)]">
          <Icon
            className={`size-5 ${getTemplateAccent(template.name)} [filter:drop-shadow(0_1px_0_rgba(255,255,255,0.9))] dark:[filter:drop-shadow(0_1px_0_rgba(0,0,0,0.6))]`}
            aria-hidden
          />
        </span>
        <span className="min-w-0 flex-1 truncate pl-1 text-[13px] font-medium text-foreground">
          {template.name}
        </span>
      </span>

      {/* `h-[39px]` reserves both lines even for a one-line blurb, so the chip
          row lands at the same height on every card. No `block` on the clamp —
          it would override `-webkit-box` and the clamp would never apply. */}
      <span className="line-clamp-2 h-[39px] w-full text-[13px] leading-normal text-muted-foreground/70">
        {template.description}
      </span>

      <span className="flex w-full items-center gap-2 overflow-hidden">
        <ToolStack template={template} />
      </span>
    </button>
  )
}

/** Templates named on the see-more tile before the "+ N more" line. */
const SEE_MORE_NAMED_COUNT = 3

/**
 * The section's sixth grid slot: a few of the hidden templates by name over a
 * call to action. Clicking anywhere opens that category's page.
 *
 * The call to action is unconditional — the tile is only ever a link, so one
 * without it reads as a card that failed to render. Only the "+ N" count is
 * conditional, since a section hiding no more than it names has no remainder
 * to count (Featured, at eight templates, is exactly that case).
 */
export function SeeMoreCard({ rest, onClick }: { rest: ApiDiscoverableAgent[]; onClick: () => void }) {
  const unnamed = rest.length - Math.min(rest.length, SEE_MORE_NAMED_COUNT)
  return (
    <button
      type="button"
      data-testid="explore-see-more"
      onClick={onClick}
      className="group flex h-[180px] w-full flex-col gap-3 rounded-2xl bg-muted/50 p-4 text-left transition-colors duration-200 hover:bg-muted"
    >
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-2">
        {rest.slice(0, SEE_MORE_NAMED_COUNT).map((template) => {
          const Icon = getTemplateIcon(template)
          return (
            <span
              key={`${template.skillsetId}/${template.path}`}
              className="flex min-w-0 items-center gap-2"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-card shadow-[0_1px_2px_0_rgba(0,0,0,0.06)]">
                <Icon className={`size-4 ${getTemplateAccent(template.name)}`} aria-hidden />
              </span>
              <span className="truncate text-[13px] text-muted-foreground">{template.name}</span>
            </span>
          )
        })}
        {/* The glyph sits in the same column as the icons above, so the label
            lines up with the names. */}
        <span className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-card shadow-[0_1px_2px_0_rgba(0,0,0,0.06)]">
            {unnamed > 0 ? (
              <Plus className="size-4 text-muted-foreground/50" aria-hidden />
            ) : (
              <ArrowRight
                className="size-4 text-muted-foreground/50 transition-transform duration-200 group-hover:translate-x-0.5"
                aria-hidden
              />
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1 truncate text-[13px] text-muted-foreground/70">
            {unnamed > 0 ? `Show ${unnamed} more` : 'See all'}
            {unnamed > 0 && (
              <ArrowRight
                className="size-3.5 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5"
                aria-hidden
              />
            )}
          </span>
        </span>
      </span>

    </button>
  )
}
