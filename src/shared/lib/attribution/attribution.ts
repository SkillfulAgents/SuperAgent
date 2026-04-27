import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { decodeOrgIdFromToken } from './token-claims'
import { getCurrentRequestUserId } from './request-context'
import {
  getOwnerAccountIdForProvider,
  getPlatformAccountIdForUserId,
} from './member-lookup'

const PLATFORM_PROVIDER_ID = 'platform'

export interface Attribution {
  applyTo(headers: Headers): void
  toHeaderEntries(): Array<[string, string]>
  /** Header entries minus the bearer (for callers that ship the bearer in a side channel). */
  toExtraHeaderEntries(): Array<[string, string]>
  /** Cache / lane key. Same key iff identical wire output. */
  getKey(): string
}

class PlatformAttribution implements Attribution {
  // Org-scoped tokens need X-Platform-Member-Id; access keys don't (proxy
  // ignores the header on that path).
  private readonly orgScoped: boolean

  constructor(
    private readonly token: string,
    private readonly memberId: string | null,
  ) {
    this.orgScoped = decodeOrgIdFromToken(token) !== null
  }

  applyTo(headers: Headers): void {
    for (const [name, value] of this.toHeaderEntries()) {
      headers.set(name, value)
    }
  }

  toHeaderEntries(): Array<[string, string]> {
    return [['Authorization', `Bearer ${this.token}`], ...this.toExtraHeaderEntries()]
  }

  toExtraHeaderEntries(): Array<[string, string]> {
    if (this.orgScoped && this.memberId) {
      return [['X-Platform-Member-Id', this.memberId]]
    }
    return []
  }

  getKey(): string {
    if (!this.orgScoped) return 'access_key'
    return this.memberId ? `member:${this.memberId}` : 'org'
  }
}

function buildPlatformAttribution(memberId: string | null): Attribution | null {
  const token = getPlatformAccessToken()
  if (!token) return null
  // Org-scoped tokens MUST carry a member id; refuse rather than produce
  // an attribution that would 401 the proxy or collapse orphan resources
  // onto the same lane. Access-key installs return memberId=null cleanly:
  // PlatformAttribution suppresses the header on that path and the proxy
  // reconstructs the member from the access_key DB row.
  const orgScoped = decodeOrgIdFromToken(token) !== null
  if (orgScoped && !memberId) return null
  return new PlatformAttribution(token, memberId)
}

/**
 * Three attribution sources -- each maps a contextual identity into an
 * outbound wire envelope. Returns null when the install can't honour the
 * request (no token / org-scoped install with unresolvable member);
 * callers handle null as "auth not configured" / skip / surface 401.
 *
 *   fromCurrentRequest()     -- ALS-bound acting user (STT, skillset, CRUD).
 *   fromAgentOwner(slug)     -- agent's billing owner (LLM container).
 *   fromResourceCreator(uid) -- vendor-bucket owner (Composio paths).
 */
export const attribution = {
  fromCurrentRequest(): Attribution | null {
    const userId = getCurrentRequestUserId()
    // No ALS scope = caller is outside an authenticated request. Refuse
    // rather than silently bind to anyone (cross-tenant leak).
    if (!userId) return null
    return buildPlatformAttribution(getPlatformAccountIdForUserId(userId))
  },

  fromAgentOwner(agentSlug: string): Attribution | null {
    return buildPlatformAttribution(getOwnerAccountIdForProvider(agentSlug, PLATFORM_PROVIDER_ID))
  },

  fromResourceCreator(ownerUserId: string | null): Attribution | null {
    if (!ownerUserId) return null
    return buildPlatformAttribution(getPlatformAccountIdForUserId(ownerUserId))
  },
}
