import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronRight } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { SettingsPageContainer, PageTitle } from '@renderer/components/layout/settings-page'
import { TemplateInstallDialog } from '@renderer/components/agents/template-install-dialog'
import { useDiscoverableAgents, slugFromAgentPath } from '@renderer/hooks/use-agent-templates'
import { useCompleteTemplateInstall } from '@renderer/hooks/use-complete-template-install'
import { TemplateAvatar } from './explore-template-card'
import {
  connectionIconSlug,
  connectionLabel,
  costTier,
  getSuggestedModels,
  getTemplateCost,
  templateCategory,
} from './template-meta'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

const DETAILS_REMARK_PLUGINS = [remarkGfm]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12 first:mt-0">
      <h3 className="text-base font-medium text-foreground">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b py-3.5 text-sm first:border-t">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-foreground">{children}</span>
    </div>
  )
}

/**
 * The `/explore/$skillsetId/$templateSlug` details page — a single-column
 * marketplace listing. Name, description, category, icon, tags, connections,
 * developer, and the long-form body all come from the skillset index; only the
 * cost and model rows are illustrative (see `template-meta`), and the footnote
 * says so.
 */
export function TemplateDetailView({
  skillsetId,
  templateSlug,
}: {
  skillsetId: string
  templateSlug: string
}) {
  const navigate = useNavigate()
  const { data: discoverableAgents, isLoading } = useDiscoverableAgents()
  const completeInstall = useCompleteTemplateInstall()
  const [templateToInstall, setTemplateToInstall] = useState<ApiDiscoverableAgent | null>(null)

  const template = useMemo(
    () =>
      discoverableAgents?.find(
        (t) => t.skillsetId === skillsetId && slugFromAgentPath(t.path) === templateSlug,
      ),
    [discoverableAgents, skillsetId, templateSlug],
  )
  const backToExplore = {
    onClick: () => void navigate({ to: '/explore' }),
    label: 'Discover New Agents',
  }

  if (!template) {
    return (
      <SettingsPageContainer className="max-w-[768px] px-[88px]">
        <PageTitle title="" back={backToExplore} />
        {isLoading || discoverableAgents === undefined ? (
          <div className="space-y-4">
            <Skeleton className="size-16 rounded-2xl" />
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-48 rounded-2xl" />
          </div>
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground" data-testid="template-not-found">
            This template is no longer available in your connected skillsets.
          </p>
        )}
      </SettingsPageContainer>
    )
  }

  const category = templateCategory(template)
  const connections = template.worksWith ?? []
  const cost = getTemplateCost(template)
  const tier = costTier(cost)

  return (
    <SettingsPageContainer className="max-w-[768px] px-[88px]">
      <PageTitle title="" back={backToExplore} />

      <div data-testid="template-detail-view" className="-mt-6">
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div data-testid="template-detail-header">
          <TemplateAvatar template={template} size="lg" />
          <div className="mt-5 flex items-start justify-between gap-6">
            <div className="min-w-0">
              <h2 className="text-3xl font-medium tracking-tight">{template.name}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{template.description}</p>
            </div>
            <Button
              type="button"
              className="shrink-0 rounded-full px-5"
              onClick={() => setTemplateToInstall(template)}
              data-testid="template-detail-install"
            >
              Install template
            </Button>
          </div>
        </div>

        {/* ── Tags ─────────────────────────────────────────────────────── */}
        {template.tags && template.tags.length > 0 && (
          <div className="mt-6 flex flex-wrap gap-2">
            {template.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full border px-3 py-1 text-xs text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* ── Apps ─────────────────────────────────────────────────────── */}
        {connections.length > 0 && (
          <Section title="Works with">
            <div className="border-t">
              {connections.map((connection) => (
                <div key={`${connection.type}-${connection.slug}`} className="flex items-center gap-3 border-b py-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-card">
                    <ServiceIcon
                      slug={connectionIconSlug(connection.slug)}
                      fallback={connection.type === 'mcp' ? 'mcp' : 'oauth'}
                      className="size-4"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">
                      {connectionLabel(connection.slug)}
                    </span>
                    <span className="block truncate text-[13px] text-muted-foreground">
                      {connection.type === 'mcp' ? 'MCP server' : 'Connected account'}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Long-form body, straight from the skillset repo ──────────── */}
        {template.details && (
          <Section title="About">
            <div className="prose prose-sm max-w-none break-words text-sm text-muted-foreground dark:prose-invert prose-headings:mt-6 prose-headings:mb-2 prose-headings:text-sm prose-headings:font-medium prose-headings:text-foreground prose-p:my-2 prose-p:leading-relaxed prose-li:my-0.5 prose-a:text-foreground prose-strong:text-foreground prose-code:text-foreground">
              <ReactMarkdown remarkPlugins={DETAILS_REMARK_PLUGINS}>{template.details}</ReactMarkdown>
            </div>
          </Section>
        )}

        {/* ── Information ──────────────────────────────────────────────── */}
        <Section title="Information">
          <div>
            {category && <InfoRow label="Category">{category}</InfoRow>}
            {template.developer && (
              <InfoRow label="Developer">
                {template.developer.url ? (
                  <a
                    href={template.developer.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {template.developer.name}
                  </a>
                ) : (
                  template.developer.name
                )}
              </InfoRow>
            )}
            <InfoRow label="Cost to run">
              ${cost.min}–${cost.max} /mo
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                <span className="text-foreground">{'$'.repeat(tier)}</span>
                {'$'.repeat(4 - tier)}
              </span>
            </InfoRow>
            <InfoRow label="Suggested models">{getSuggestedModels().join(', ')}</InfoRow>
            <InfoRow label="Source">{template.skillsetName}</InfoRow>
            <InfoRow label="Version">{template.version}</InfoRow>
          </div>
        </Section>

        <p className="mt-12 border-t pt-6 text-[13px]/6 text-muted-foreground">
          This template may connect to one or more apps, as listed above. When connected, the agent
          can read and write on your behalf within the limits you grant it. Cost estimates are
          illustrative while the marketplace is in preview.
        </p>
      </div>

      <TemplateInstallDialog
        template={templateToInstall}
        onClose={() => setTemplateToInstall(null)}
        onInstalled={completeInstall}
      />
    </SettingsPageContainer>
  )
}
