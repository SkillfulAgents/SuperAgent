import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { SettingsPageContainer, PageTitle } from '@renderer/components/layout/settings-page'
import { TemplateInstallDialog } from '@renderer/components/agents/template-install-dialog'
import { useDiscoverableAgents, slugFromAgentPath } from '@renderer/hooks/use-agent-templates'
import { useCompleteTemplateInstall } from '@renderer/hooks/use-complete-template-install'
import { TemplateAvatar } from './explore-template-card'
import {
  connectionIconSlug,
  connectionLabel,
  INVENTORY_SECTION_LABEL,
  INVENTORY_SECTION_TITLES,
  getTemplateExamples,
  getTemplateGradient,
  inventoryIcon,
  inventoryLabel,
  parseInventory,
  parseTemplateDetails,
  templateCategory,
} from './template-meta'
import { ArrowUp } from 'lucide-react'
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
 * marketplace listing. Every value on it comes from the skillset index: name,
 * description, category, icon, tags, connections, developer, and the
 * section-by-section body.
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
  const detailSections = template.details ? parseTemplateDetails(template.details) : []
  const useCases = getTemplateExamples(template.details)

  return (
    <SettingsPageContainer className="max-w-[768px] px-[88px]">
      <PageTitle title="" back={backToExplore} />

      <div data-testid="template-detail-view" className="-mt-6">
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div data-testid="template-detail-header">
          <div className="flex items-center justify-between gap-6">
            <TemplateAvatar template={template} size="lg" />
            <Button
              type="button"
              className="shrink-0"
              onClick={() => setTemplateToInstall(template)}
              data-testid="template-detail-install"
            >
              Install template
            </Button>
          </div>
          <div className="mt-5 min-w-0">
            <h2 className="text-2xl font-medium tracking-tight">{template.name}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">{template.description}</p>
          </div>
        </div>

        {/* ── Hero: the template's own sample use cases, as example prompts.
            Decorative and inert — the arrows are part of the picture, not
            controls. The wash is the template's accent hue over the grey. ── */}
        {useCases.length > 0 && (
          <div className="relative mt-8 overflow-hidden rounded-2xl bg-muted/60">
            <div
              className={`absolute inset-0 bg-gradient-to-tl ${getTemplateGradient(template.name)}`}
              aria-hidden
            />
            <div className="relative flex flex-col items-center gap-3 px-6 py-12" aria-hidden>
              {useCases.slice(0, 3).map((useCase) => (
                <span
                  key={useCase}
                  className="flex w-full max-w-[88%] items-center gap-3 rounded-2xl bg-card/85 py-2.5 pl-4 pr-2.5 shadow-sm backdrop-blur-xl"
                >
                  <span className="min-w-0 flex-1 text-sm/6 text-foreground">
                    <span className="font-medium">@{template.name}</span> {useCase}
                  </span>
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg border bg-white text-black shadow-sm">
                    <ArrowUp className="size-3.5" />
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Apps ─────────────────────────────────────────────────────── */}
        {connections.length > 0 && (
          <Section title="Works with">
            <div className="flex flex-wrap gap-2">
              {connections.map((connection) => (
                <span
                  key={`${connection.type}-${connection.slug}`}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] text-muted-foreground"
                >
                  <ServiceIcon
                    slug={connectionIconSlug(connection.slug)}
                    fallback={connection.type === 'mcp' ? 'mcp' : 'oauth'}
                    className="size-[15px] shrink-0"
                  />
                  {connectionLabel(connection.slug)}
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* ── The repo's own copy, one Section per `##` heading ─────────── */}
        {detailSections.map((section) => {
          const isInventory = INVENTORY_SECTION_TITLES.has(section.title)
          const files = isInventory ? parseInventory(section.body) : []
          return (
            <Section
              key={section.title}
              title={isInventory ? INVENTORY_SECTION_LABEL : section.title}
            >
              {files.length > 0 ? (
                <TooltipProvider delayDuration={200}>
                  <div className="flex flex-wrap gap-2">
                    {files.map((file) => {
                      const ItemIcon = inventoryIcon(file)
                      return (
                        <Tooltip key={file.name}>
                          <TooltipTrigger asChild>
                            <span className="inline-flex cursor-default items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-xs text-muted-foreground">
                              <ItemIcon
                                className="size-3.5 shrink-0 text-muted-foreground/60"
                                aria-hidden
                              />
                              {inventoryLabel(file.name)}
                            </span>
                          </TooltipTrigger>
                          {/* The chip shows only the leaf name, so the tooltip
                              carries the full path along with the blurb. */}
                          <TooltipContent className="max-w-xs">
                            <span className="block font-mono text-[11px]">{file.name}</span>
                            {file.description && (
                              <span className="mt-1 block">{file.description}</span>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                </TooltipProvider>
              ) : (
                <div className="prose prose-sm max-w-none break-words text-sm text-muted-foreground dark:prose-invert prose-headings:mt-5 prose-headings:mb-1.5 prose-headings:text-sm prose-headings:font-medium prose-headings:text-foreground prose-p:my-2 prose-p:leading-relaxed prose-li:my-0.5 prose-a:text-foreground prose-strong:text-foreground prose-code:text-foreground">
                  <ReactMarkdown remarkPlugins={DETAILS_REMARK_PLUGINS}>{section.body}</ReactMarkdown>
                </div>
              )}
            </Section>
          )
        })}

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
            <InfoRow label="Source">{template.skillsetName}</InfoRow>
            <InfoRow label="Version">{template.version}</InfoRow>
          </div>
        </Section>

        <p className="mt-12 border-t pt-6 text-[13px]/6 text-muted-foreground">
          This template may connect to one or more apps, as listed above. When connected, the agent
          can read and write on your behalf within the limits you grant it.
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
