export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface RemoteMcpConfig {
  id: string
  name: string
  proxyUrl: string
  tools: McpToolInfo[]
}

export interface OAuthMetadata {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
  authorization_response_iss_parameter_supported?: boolean
}

export interface OAuthTokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}
