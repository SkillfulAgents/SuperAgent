export interface UsageByAgent {
  agentSlug: string
  agentName: string
  cost: number
}

export interface UsageByModel {
  model: string
  cost: number
}

export interface DailyUsageEntry {
  date: string
  totalCost: number
  byAgent: UsageByAgent[]
  byModel: UsageByModel[]
}

export interface UsageResponse {
  daily: DailyUsageEntry[]
}
