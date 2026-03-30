import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { Button } from '@renderer/components/ui/button'
import { ToolCallItem } from '@renderer/components/messages/tool-call-item'
import { QuestionRequestItem } from '@renderer/components/messages/question-request-item'
import { SecretRequestItem } from '@renderer/components/messages/secret-request-item'
import { ConnectedAccountRequestItem } from '@renderer/components/messages/connected-account-request-item'
import { FileRequestItem } from '@renderer/components/messages/file-request-item'
import { BrowserInputRequestItem } from '@renderer/components/messages/browser-input-request-item'
import { ScriptRunRequestItem } from '@renderer/components/messages/script-run-request-item'
import { RemoteMcpRequestItem } from '@renderer/components/messages/remote-mcp-request-item'
import { ComputerUseRequestItem } from '@renderer/components/messages/computer-use-request-item'
import type { ApiToolCall } from '@shared/lib/types/api'
import { ExternalLink } from 'lucide-react'

const DEMO_AGENT_SLUG = 'dev-approvals'
const DEMO_SESSION_ID = 'dev-approvals-session'

const questionBaseProps = {
  sessionId: DEMO_SESSION_ID,
  agentSlug: DEMO_AGENT_SLUG,
  onComplete: () => {},
}

const singleSelectQuestions = [
  {
    question: 'Which database should we use?',
    header: 'Single-select',
    options: [
      { label: 'PostgreSQL', description: 'Reliable relational database for transactional workloads.' },
      { label: 'SQLite', description: 'Fast local-first option for small installs and demos.' },
      { label: 'MongoDB', description: 'Flexible document store for rapidly changing schemas.' },
    ],
    multiSelect: false,
  },
]

const multiSelectQuestions = [
  {
    question: 'Which API features should we ship in v1?',
    header: 'Multi-select',
    options: [
      { label: 'OAuth', description: 'Third-party sign-in for external integrations.' },
      { label: 'Webhooks', description: 'Push events to customer backends in real time.' },
      { label: 'Rate limits', description: 'Protect the API with per-key request quotas.' },
      { label: 'Audit logs', description: 'Track every privileged action and actor.' },
    ],
    multiSelect: true,
  },
]

const markdownPreviewQuestions = [
  {
    question: 'Which layout should we build first?',
    header: 'Markdown preview',
    options: [
      {
        label: 'Sidebar layout',
        description: '```text\n+----------------------+\n| nav  | main content |\n| nav  | main content |\n+----------------------+\n```',
      },
      {
        label: 'Topbar layout',
        description: '```text\n+----------------------+\n|      top nav        |\n+----------------------+\n|     main content    |\n+----------------------+\n```',
      },
    ],
    multiSelect: false,
  },
]

const sideBySideQuestions = [
  {
    question: 'Which language?',
    header: 'Language',
    options: [
      { label: 'TypeScript', description: 'Safer refactors and richer editor support.' },
      { label: 'Python', description: 'Fast iteration and broad ecosystem support.' },
    ],
    multiSelect: false,
  },
  {
    question: 'Where should we deploy?',
    header: 'Deploy target',
    options: [
      { label: 'AWS', description: 'Managed services and operational depth.' },
      { label: 'Fly.io', description: 'Simple global deploys for smaller apps.' },
    ],
    multiSelect: false,
  },
  {
    question: 'What support tier should we offer?',
    header: 'Support',
    options: [
      { label: 'Email', description: 'Best for smaller teams with lower urgency.' },
      { label: 'Slack', description: 'Faster shared-channel support for paid plans.' },
      { label: 'Dedicated CSM', description: 'High-touch support for enterprise customers.' },
    ],
    multiSelect: false,
  },
]

function demoToolCall(toolCall: ApiToolCall) {
  return (
    <ToolCallItem
      toolCall={toolCall}
      messageCreatedAt={new Date()}
      isSessionActive={false}
      agentSlug={DEMO_AGENT_SLUG}
    />
  )
}

function ExampleCard({
  title,
  description,
  fieldNames,
  children,
}: {
  title: string
  description: string
  fieldNames: string[]
  children: React.ReactNode
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Source Params
          </div>
          <div className="flex flex-wrap gap-2">
            {fieldNames.map((fieldName) => (
              <code
                key={fieldName}
                className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
              >
                {fieldName}
              </code>
            ))}
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

export function ApprovalGalleryPage() {
  const closeGallery = () => {
    window.location.assign(window.location.pathname)
  }

  return (
    <div className="h-full overflow-y-auto bg-muted/20">
      <div className="mx-auto max-w-7xl space-y-6 p-6">
        <div className="flex flex-col gap-4 rounded-xl border bg-background p-6 shadow-sm md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Dev Gallery
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Approval and Request Surfaces</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              This hidden page exists to make the approval and user-input UI easy to review in one place.
              It uses the real renderer components so we can refine spacing, copy, hierarchy, and interaction
              without having to trigger each flow manually.
            </p>
            <p className="text-xs text-muted-foreground">
              Open it with <code className="rounded bg-muted px-1.5 py-0.5">?dev=approvals</code> or toggle it with{' '}
              <code className="rounded bg-muted px-1.5 py-0.5">Cmd/Ctrl+Shift+A</code>.
            </p>
          </div>
          <Button variant="outline" onClick={closeGallery}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Back To App
          </Button>
        </div>

        <Tabs defaultValue="questions" className="space-y-4">
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="questions">Questions</TabsTrigger>
            <TabsTrigger value="requests">Requests</TabsTrigger>
            <TabsTrigger value="approvals">Approvals</TabsTrigger>
            <TabsTrigger value="tool-calls">Tool Cards</TabsTrigger>
            <TabsTrigger value="planning">Planning</TabsTrigger>
          </TabsList>

          <TabsContent value="questions" className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-2">
              <ExampleCard
                title="Single-select"
                description="Pick one option, like choosing a database."
                fieldNames={[
                  'questions[].header',
                  'questions[].question',
                  'questions[].options[].label',
                  'questions[].options[].description',
                  'questions[].multiSelect',
                ]}
              >
                <QuestionRequestItem
                  {...questionBaseProps}
                  toolUseId="question-single"
                  questions={singleSelectQuestions}
                />
              </ExampleCard>

              <ExampleCard
                title="Multi-select"
                description="Pick multiple options, like choosing API features."
                fieldNames={[
                  'questions[].header',
                  'questions[].question',
                  'questions[].options[].label',
                  'questions[].options[].description',
                  'questions[].multiSelect',
                ]}
              >
                <QuestionRequestItem
                  {...questionBaseProps}
                  toolUseId="question-multi"
                  questions={multiSelectQuestions}
                />
              </ExampleCard>

              <ExampleCard
                title="Markdown preview"
                description="Option descriptions can carry ASCII or markdown-like previews."
                fieldNames={[
                  'questions[].header',
                  'questions[].question',
                  'questions[].options[].label',
                  'questions[].options[].description',
                ]}
              >
                <QuestionRequestItem
                  {...questionBaseProps}
                  toolUseId="question-markdown"
                  questions={markdownPreviewQuestions}
                />
              </ExampleCard>

              <ExampleCard
                title="Multiple questions in one"
                description="Current implementation stacks the two prompts in one card."
                fieldNames={[
                  'questions[].header',
                  'questions[].question',
                  'questions[].options[].label',
                  'questions[].options[].description',
                ]}
              >
                <QuestionRequestItem
                  {...questionBaseProps}
                  toolUseId="question-side-by-side"
                  questions={sideBySideQuestions}
                />
              </ExampleCard>
            </div>
          </TabsContent>

          <TabsContent value="requests" className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-2">
              <ExampleCard
                title="Secret request"
                description="API key or token entry."
                fieldNames={['secretName', 'reason']}
              >
                <SecretRequestItem
                  toolUseId="secret-request"
                  secretName="GITHUB_TOKEN"
                  reason="Needed to open and update pull requests on your behalf."
                  sessionId={DEMO_SESSION_ID}
                  agentSlug={DEMO_AGENT_SLUG}
                  onComplete={() => {}}
                />
              </ExampleCard>

              <ExampleCard
                title="File request"
                description="Upload a file with optional type hints."
                fieldNames={['description', 'fileTypes']}
              >
                <FileRequestItem
                  toolUseId="file-request"
                  description="Upload the latest CSV export from finance."
                  fileTypes=".csv,.xlsx"
                  sessionId={DEMO_SESSION_ID}
                  agentSlug={DEMO_AGENT_SLUG}
                  onComplete={() => {}}
                />
              </ExampleCard>

              <ExampleCard
                title="Browser input"
                description="Manual browser takeover for login, CAPTCHA, or 2FA."
                fieldNames={['message', 'requirements[]']}
              >
                <BrowserInputRequestItem
                  toolUseId="browser-input"
                  message="Please complete login in the browser tab and return here when the dashboard is visible."
                  requirements={[
                    'Sign in with your work email',
                    'Complete any MFA challenge',
                    'Stop once the billing dashboard has loaded',
                  ]}
                  sessionId={DEMO_SESSION_ID}
                  agentSlug={DEMO_AGENT_SLUG}
                  onComplete={() => {}}
                />
              </ExampleCard>

              <ExampleCard
                title="Run script"
                description="Host-machine script approval."
                fieldNames={['explanation', 'scriptType', 'script']}
              >
                <ScriptRunRequestItem
                  toolUseId="script-request"
                  script={`osascript -e 'tell application "System Events" to get name of every process'`}
                  explanation="List active desktop apps so the agent can target the correct window."
                  scriptType="applescript"
                  sessionId={DEMO_SESSION_ID}
                  agentSlug={DEMO_AGENT_SLUG}
                  onComplete={() => {}}
                />
              </ExampleCard>

              <ExampleCard
                title="Connected account: GitHub"
                description="OAuth account linking example using GitHub."
                fieldNames={['toolkit', 'reason']}
              >
                <ConnectedAccountRequestItem
                  toolUseId="connected-account"
                  toolkit="github"
                  reason="Needed to read issues and post review comments."
                  sessionId={DEMO_SESSION_ID}
                  agentSlug={DEMO_AGENT_SLUG}
                  onComplete={() => {}}
                />
              </ExampleCard>

              <ExampleCard
                title="Connected account: Gmail"
                description="OAuth/API access request example using Gmail."
                fieldNames={['toolkit', 'reason']}
              >
                <ConnectedAccountRequestItem
                  toolUseId="connected-account-gmail"
                  toolkit="gmail"
                  reason="Needed to read your inbox and draft replies."
                  sessionId={DEMO_SESSION_ID}
                  agentSlug={DEMO_AGENT_SLUG}
                  onComplete={() => {}}
                />
              </ExampleCard>

              <ExampleCard
                title="Connected account: no accounts"
                description="Empty-state account access request example using a CRM with no connected accounts."
                fieldNames={['toolkit', 'reason']}
              >
                <ConnectedAccountRequestItem
                  toolUseId="connected-account-attio"
                  toolkit="attio"
                  reason="Needed to look up CRM records and update account notes."
                  sessionId={DEMO_SESSION_ID}
                  agentSlug={DEMO_AGENT_SLUG}
                  onComplete={() => {}}
                />
              </ExampleCard>

              <ExampleCard
                title="Remote MCP"
                description="Connect an external MCP server, including auth-hinted flows."
                fieldNames={['name', 'url', 'reason', 'authHint']}
              >
                <RemoteMcpRequestItem
                  toolUseId="remote-mcp"
                  url="https://mcp.example.com/server"
                  name="Example MCP"
                  reason="Needed to access design-system tools hosted outside this workspace."
                  authHint="oauth"
                  sessionId={DEMO_SESSION_ID}
                  agentSlug={DEMO_AGENT_SLUG}
                  onComplete={() => {}}
                />
              </ExampleCard>
            </div>
          </TabsContent>

          <TabsContent value="approvals" className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-2">
              <ExampleCard
                title="Computer use approval"
                description="The actual approval card we currently use for host and app control."
                fieldNames={['method', 'params', 'permissionLevel', 'appName']}
              >
                <ComputerUseRequestItem
                  toolUseId="computer-use"
                  method="open"
                  params={{ app: 'Terminal', target: '/Applications/Utilities/Terminal.app' }}
                  permissionLevel="use_application"
                  appName="Terminal"
                  sessionId={DEMO_SESSION_ID}
                  agentSlug={DEMO_AGENT_SLUG}
                  onComplete={() => {}}
                />
              </ExampleCard>

              <ExampleCard
                title="Host shell approval"
                description="This repo currently models shell-level approval through the same computer-use permission system."
                fieldNames={['method', 'params', 'permissionLevel']}
              >
                <ComputerUseRequestItem
                  toolUseId="host-shell"
                  method="shell"
                  params={{ command: 'git status --short' }}
                  permissionLevel="use_host_shell"
                  sessionId={DEMO_SESSION_ID}
                  agentSlug={DEMO_AGENT_SLUG}
                  onComplete={() => {}}
                />
              </ExampleCard>
            </div>
          </TabsContent>

          <TabsContent value="tool-calls" className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-2">
              <ExampleCard
                title="Bash"
                description="Current tool-call surface for shell commands."
                fieldNames={['toolCall.name', 'toolCall.input.command', 'toolCall.input.description', 'toolCall.result']}
              >
                {demoToolCall({
                  id: 'bash-demo',
                  name: 'Bash',
                  input: {
                    command: 'npm run typecheck',
                    description: 'Run the workspace typechecker',
                  },
                  result: 'Typecheck completed successfully.',
                })}
              </ExampleCard>

              <ExampleCard
                title="Write (new file)"
                description="Current tool-call surface when a file is created."
                fieldNames={['toolCall.name', 'toolCall.input.file_path', 'toolCall.input.content', 'toolCall.result']}
              >
                {demoToolCall({
                  id: 'write-new-demo',
                  name: 'Write',
                  input: {
                    file_path: '/workspace/src/dev/approval-gallery.tsx',
                    content: 'export function ApprovalGallery() {}',
                  },
                  result: 'File created successfully.',
                })}
              </ExampleCard>

              <ExampleCard
                title="Write (existing file)"
                description="Current tool-call surface when a file is edited."
                fieldNames={['toolCall.name', 'toolCall.input.file_path', 'toolCall.input.content', 'toolCall.result']}
              >
                {demoToolCall({
                  id: 'write-edit-demo',
                  name: 'Write',
                  input: {
                    file_path: '/workspace/src/renderer/components/messages/question-request-item.tsx',
                    content: '// updated content...',
                  },
                  result: 'Existing file updated successfully.',
                })}
              </ExampleCard>

              <ExampleCard
                title="Schedule task"
                description="This one is a tool-call renderer, not a blocking approval card."
                fieldNames={['scheduleType', 'scheduleExpression', 'prompt', 'name', 'timezone', 'result']}
              >
                {demoToolCall({
                  id: 'schedule-task-demo',
                  name: 'mcp__user-input__schedule_task',
                  input: {
                    scheduleType: 'cron',
                    scheduleExpression: '0 9 * * 1-5',
                    prompt: 'Check for new issues and summarize them',
                    name: 'Daily Issue Summary',
                    timezone: 'America/New_York',
                  },
                  result: 'Task scheduled successfully. ID: task_123',
                })}
              </ExampleCard>
            </div>
          </TabsContent>

          <TabsContent value="planning" className="space-y-4">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Planning surfaces</CardTitle>
                <CardDescription>
                  Enter-plan and exit-plan approvals are not currently implemented as dedicated renderer components in this repo.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>
                  I only found a reference to <code className="rounded bg-muted px-1.5 py-0.5">ExitPlanMode</code> in a
                  reference message stream fixture, not in the renderer tree.
                </p>
                <p>
                  This tab is here as a reminder that if we add those surfaces, we should drop them into this gallery too.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
