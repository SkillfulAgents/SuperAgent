interface OrgSourceLabelProps {
  orgName: string | null | undefined
}

export function OrgSourceLabel({ orgName }: OrgSourceLabelProps) {
  if (!orgName) return null

  return (
    <span className="text-xs text-muted-foreground">
      From org: <span className="font-semibold text-foreground">{orgName}</span>
    </span>
  )
}
