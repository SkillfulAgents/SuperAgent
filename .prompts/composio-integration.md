I want to add a new integration with Composio for connecting to external OAuth accounts. Occasionally, agents will need access to external services (like Gmail, Twitter, etc) on behalf of the user. Instead of the agent asking for an API key or OAuth token directly, we want to manage these connections via Composio.

The feature will work very similarly to how we manage secrets currently:
- The agent will request to connect an account of a specific type (e.g., Gmail) via a new tool call
- This will trigger a UI flow with a login button that the user can click to authenticate with the external service via Composio's OAuth flow
- Once authenticated, Composio will manage the tokens and provide access to the agent when needed
- We will set the connected account info as environment variables in the agent's runtime environment, similar to how we handle secrets (should have a common naming convention, e.g., CONNECTED_ACCOUNT_GMAIL, etc). The env var will store a JSON mapping from account names to tokens (as there can be multiple connected accounts of the same type)

Some differences though:
- We will need an app-level setting for the Composio API key to authenticate our requests to their API. They can also set the user ID for us to use in Composio (the app is single user, so they can set whatever they want, maybe just their own user ID)
- We will need to handle multiple connected accounts of the same type (e.g., multiple Gmail accounts). Each account should have an optional name / label to distinguish them.
- We will need new DB tables to track the connected accounts and their mappings to Composio IDs. We will need to track accounts at two levels - at the app level (for all connected accounts) and at the agent level
    - When connecting to an account, we will save it at the app level first. The next time a different agent requests the same type of account, we can show the user a list of already connected accounts to choose from, or let them connect a new one.
- When we spin up an agent runtime, we will need to fetch the list of connected accounts for that agent (based on the app-level connected accounts) and set the appropriate environment variables. Always fetch from Composio to ensure we have the latest tokens.
- In the agent settings, we will need a new section to manage connected accounts. This will show the list of connected accounts at the app level, and allow users to add / remove accounts. We can also show which agents are using each account.

Additional Points:
- At the agent home, we should show a list of connected accounts that the agent can use just above the skills section.

# Composio - List authentication configurations with optional filters

GET https://backend.composio.dev/api/v3/auth_configs

Reference: https://docs.composio.dev/api-reference/auth-configs/get-auth-configs

## OpenAPI Specification

```yaml
openapi: 3.1.1
info:
  title: List authentication configurations with optional filters
  version: endpoint_authConfigs.getAuthConfigs
paths:
  /api/v3/auth_configs:
    get:
      operationId: get-auth-configs
      summary: List authentication configurations with optional filters
      tags:
        - - subpackage_authConfigs
      parameters:
        - name: is_composio_managed
          in: query
          description: Whether to filter by composio managed auth configs
          required: false
          schema:
            type: string
        - name: toolkit_slug
          in: query
          description: Comma-separated list of toolkit slugs to filter auth configs by
          required: false
          schema:
            type: string
        - name: deprecated_app_id
          in: query
          description: The app id to filter by
          required: false
          schema:
            type: string
        - name: deprecated_status
          in: query
          required: false
          schema:
            type: string
        - name: show_disabled
          in: query
          description: Show disabled auth configs
          required: false
          schema:
            type: boolean
        - name: search
          in: query
          description: Search auth configs by name
          required: false
          schema:
            type: string
        - name: limit
          in: query
          description: Number of items per page
          required: false
          schema:
            type: number
            format: double
        - name: cursor
          in: query
          description: >-
            Cursor for pagination. The cursor is a base64 encoded string of the
            page and limit. The page is the page number and the limit is the
            number of items per page. The cursor is used to paginate through the
            items. The cursor is not required for the first page.
          required: false
          schema:
            type: string
        - name: x-api-key
          in: header
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Successfully fetched auth configs
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/type_authConfigs:GetAuthConfigsResponse'
        '400':
          description: Bad request
          content: {}
        '401':
          description: Unauthorized
          content: {}
        '404':
          description: Not found
          content: {}
        '500':
          description: Internal server error
          content: {}
components:
  schemas:
    type_authConfigs:GetAuthConfigsResponseItemsItemType:
      type: string
      enum:
        - value: default
        - value: custom
    type_authConfigs:GetAuthConfigsResponseItemsItemToolkit:
      type: object
      properties:
        slug:
          type: string
        logo:
          type: string
      required:
        - slug
        - logo
    type_authConfigs:GetAuthConfigsResponseItemsItemAuthScheme:
      type: string
      enum:
        - value: OAUTH2
        - value: OAUTH1
        - value: API_KEY
        - value: BASIC
        - value: BILLCOM_AUTH
        - value: BEARER_TOKEN
        - value: GOOGLE_SERVICE_ACCOUNT
        - value: NO_AUTH
        - value: BASIC_WITH_JWT
        - value: CALCOM_AUTH
        - value: SERVICE_ACCOUNT
    type_authConfigs:GetAuthConfigsResponseItemsItemProxyConfig:
      type: object
      properties:
        proxy_url:
          type: string
          format: uri
        proxy_auth_key:
          type: string
      required:
        - proxy_url
    type_authConfigs:GetAuthConfigsResponseItemsItemStatus:
      type: string
      enum:
        - value: ENABLED
        - value: DISABLED
    type_authConfigs:GetAuthConfigsResponseItemsItemToolAccessConfig:
      type: object
      properties:
        tools_for_connected_account_creation:
          type: array
          items:
            type: string
        tools_available_for_execution:
          type: array
          items:
            type: string
    type_authConfigs:GetAuthConfigsResponseItemsItemDeprecatedParams:
      type: object
      properties:
        default_connector_id:
          type: string
        member_uuid:
          type: string
        toolkit_id:
          type: string
        expected_input_fields:
          type: array
          items:
            type: object
            additionalProperties:
              description: Any type
    type_authConfigs:GetAuthConfigsResponseItemsItem:
      type: object
      properties:
        id:
          type: string
        uuid:
          type: string
        type:
          $ref: >-
            #/components/schemas/type_authConfigs:GetAuthConfigsResponseItemsItemType
        toolkit:
          $ref: >-
            #/components/schemas/type_authConfigs:GetAuthConfigsResponseItemsItemToolkit
        name:
          type: string
        auth_scheme:
          $ref: >-
            #/components/schemas/type_authConfigs:GetAuthConfigsResponseItemsItemAuthScheme
        is_composio_managed:
          type: boolean
        credentials:
          type: object
          additionalProperties:
            description: Any type
        proxy_config:
          $ref: >-
            #/components/schemas/type_authConfigs:GetAuthConfigsResponseItemsItemProxyConfig
        status:
          $ref: >-
            #/components/schemas/type_authConfigs:GetAuthConfigsResponseItemsItemStatus
        created_by:
          type: string
        created_at:
          type: string
        last_updated_at:
          type: string
        no_of_connections:
          type: number
          format: double
        expected_input_fields:
          type: array
          items:
            description: Any type
        restrict_to_following_tools:
          type: array
          items:
            type: string
        tool_access_config:
          $ref: >-
            #/components/schemas/type_authConfigs:GetAuthConfigsResponseItemsItemToolAccessConfig
        deprecated_params:
          $ref: >-
            #/components/schemas/type_authConfigs:GetAuthConfigsResponseItemsItemDeprecatedParams
      required:
        - id
        - uuid
        - type
        - toolkit
        - name
        - status
        - no_of_connections
        - tool_access_config
        - deprecated_params
    type_authConfigs:GetAuthConfigsResponse:
      type: object
      properties:
        items:
          type: array
          items:
            $ref: >-
              #/components/schemas/type_authConfigs:GetAuthConfigsResponseItemsItem
        next_cursor:
          type: string
        total_pages:
          type: number
          format: double
        current_page:
          type: number
          format: double
        total_items:
          type: number
          format: double
      required:
        - items
        - total_pages
        - current_page
        - total_items

```

## SDK Code Examples

```javascript
const url = 'https://backend.composio.dev/api/v3/auth_configs';
const options = {method: 'GET', headers: {'x-api-key': '<apiKey>'}};

try {
  const response = await fetch(url, options);
  const data = await response.json();
  console.log(data);
} catch (error) {
  console.error(error);
}
```

# List connected accounts with optional filters

GET https://backend.composio.dev/api/v3/connected_accounts

Reference: https://docs.composio.dev/api-reference/connected-accounts/get-connected-accounts

## OpenAPI Specification

```yaml
openapi: 3.1.1
info:
  title: List connected accounts with optional filters
  version: endpoint_connectedAccounts.getConnectedAccounts
paths:
  /api/v3/connected_accounts:
    get:
      operationId: get-connected-accounts
      summary: List connected accounts with optional filters
      tags:
        - - subpackage_connectedAccounts
      parameters:
        - name: toolkit_slugs
          in: query
          description: The toolkit slugs of the connected accounts
          required: false
          schema:
            type: string
        - name: statuses
          in: query
          description: The status of the connected account
          required: false
          schema:
            $ref: >-
              #/components/schemas/type_connectedAccounts:GetConnectedAccountsRequestStatusesItem
        - name: cursor
          in: query
          description: The cursor to paginate through the connected accounts
          required: false
          schema:
            type: string
        - name: limit
          in: query
          description: The limit of the connected accounts to return
          required: false
          schema:
            type: number
            format: double
        - name: user_ids
          in: query
          description: The user ids of the connected accounts
          required: false
          schema:
            type: string
        - name: auth_config_ids
          in: query
          description: The auth config ids of the connected accounts
          required: false
          schema:
            type: string
        - name: connected_account_ids
          in: query
          description: The connected account ids to filter by
          required: false
          schema:
            type: string
        - name: order_by
          in: query
          description: The order by of the connected accounts
          required: false
          schema:
            $ref: >-
              #/components/schemas/type_connectedAccounts:GetConnectedAccountsRequestOrderBy
        - name: order_direction
          in: query
          description: The order direction of the connected accounts
          required: false
          schema:
            $ref: >-
              #/components/schemas/type_connectedAccounts:GetConnectedAccountsRequestOrderDirection
        - name: labels
          in: query
          description: The labels of the connected accounts
          required: false
          schema:
            type: string
        - name: x-api-key
          in: header
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Successfully retrieved connected accounts
          content:
            application/json:
              schema:
                $ref: >-
                  #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponse
        '400':
          description: Bad request
          content: {}
        '401':
          description: Unauthorized
          content: {}
        '422':
          description: Unprocessable entity
          content: {}
        '500':
          description: Internal server error
          content: {}
components:
  schemas:
    type_connectedAccounts:GetConnectedAccountsRequestStatusesItem:
      type: string
      enum:
        - value: INITIALIZING
        - value: INITIATED
        - value: ACTIVE
        - value: FAILED
        - value: EXPIRED
        - value: INACTIVE
    type_connectedAccounts:GetConnectedAccountsRequestOrderBy:
      type: string
      enum:
        - value: created_at
        - value: updated_at
    type_connectedAccounts:GetConnectedAccountsRequestOrderDirection:
      type: string
      enum:
        - value: asc
        - value: desc
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemToolkit:
      type: object
      properties:
        slug:
          type: string
      required:
        - slug
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemAuthConfigAuthScheme:
      type: string
      enum:
        - value: OAUTH2
        - value: OAUTH1
        - value: API_KEY
        - value: BASIC
        - value: BILLCOM_AUTH
        - value: BEARER_TOKEN
        - value: GOOGLE_SERVICE_ACCOUNT
        - value: NO_AUTH
        - value: BASIC_WITH_JWT
        - value: CALCOM_AUTH
        - value: SERVICE_ACCOUNT
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemAuthConfigDeprecated:
      type: object
      properties:
        uuid:
          type: string
          format: uuid
      required:
        - uuid
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemAuthConfig:
      type: object
      properties:
        id:
          type: string
        auth_scheme:
          $ref: >-
            #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemAuthConfigAuthScheme
        is_composio_managed:
          type: boolean
        is_disabled:
          type: boolean
        deprecated:
          $ref: >-
            #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemAuthConfigDeprecated
      required:
        - id
        - auth_scheme
        - is_composio_managed
        - is_disabled
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStatus:
      type: string
      enum:
        - value: INITIALIZING
        - value: INITIATED
        - value: ACTIVE
        - value: FAILED
        - value: EXPIRED
        - value: INACTIVE
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth1Val:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            oauth_token:
              type: string
            authUri:
              type: string
            oauth_token_secret:
              type: string
            redirectUrl:
              type: string
            callbackUrl:
              type: string
          required:
            - status
            - oauth_token
            - authUri
            - oauth_token_secret
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            oauth_token:
              type: string
            oauth_token_secret:
              type: string
            oauth_verifier:
              type: string
            consumer_key:
              type: string
            redirectUrl:
              type: string
            callback_url:
              type: string
          required:
            - status
            - oauth_token
            - oauth_token_secret
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            oauth_token:
              type: string
            oauth_token_secret:
              type: string
            oauth_verifier:
              type: string
            consumer_key:
              type: string
            redirectUrl:
              type: string
            callback_url:
              type: string
          required:
            - status
            - oauth_token
            - oauth_token_secret
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValActiveExpiresIn:
      oneOf:
        - type: number
          format: double
        - type: string
        - description: Any type
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValActiveScope:
      oneOf:
        - type: string
        - type: array
          items:
            type: string
        - description: Any type
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValActiveAuthedUser:
      type: object
      properties:
        access_token:
          type: string
        scope:
          type: string
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValInactiveExpiresIn:
      oneOf:
        - type: number
          format: double
        - type: string
        - description: Any type
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValInactiveScope:
      oneOf:
        - type: string
        - type: array
          items:
            type: string
        - description: Any type
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValInactiveAuthedUser:
      type: object
      properties:
        access_token:
          type: string
        scope:
          type: string
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2Val:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            code_verifier:
              type: string
            redirectUrl:
              type: string
            callback_url:
              type: string
            finalRedirectUri:
              type: string
            webhook_signature:
              type: string
          required:
            - status
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            access_token:
              type: string
            id_token:
              type: string
            token_type:
              type: string
            refresh_token:
              type: string
            expires_in:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValActiveExpiresIn
            scope:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValActiveScope
            webhook_signature:
              type: string
            authed_user:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValActiveAuthedUser
          required:
            - status
            - access_token
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            access_token:
              type: string
            id_token:
              type: string
            token_type:
              type: string
            refresh_token:
              type: string
            expires_in:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValInactiveExpiresIn
            scope:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValInactiveScope
            webhook_signature:
              type: string
            authed_user:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2ValInactiveAuthedUser
          required:
            - status
            - access_token
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateApiKeyVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            generic_api_key:
              type: string
            api_key:
              type: string
            bearer_token:
              type: string
            basic_encoded:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            generic_api_key:
              type: string
            api_key:
              type: string
            bearer_token:
              type: string
            basic_encoded:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateBasicVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateBearerTokenVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            token:
              type: string
          required:
            - status
            - token
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            token:
              type: string
          required:
            - status
            - token
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateGoogleServiceAccountVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            redirectUrl:
              type: string
            composio_link_redirect_url:
              type: string
          required:
            - status
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            credentials_json:
              type: string
          required:
            - status
            - credentials_json
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            credentials_json:
              type: string
          required:
            - status
            - credentials_json
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateNoAuthVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateCalcomAuthVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateBillcomAuthVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            redirectUrl:
              type: string
          required:
            - status
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            sessionId:
              type: string
            devKey:
              type: string
          required:
            - status
            - sessionId
            - devKey
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            sessionId:
              type: string
            devKey:
              type: string
          required:
            - status
            - sessionId
            - devKey
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateBasicWithJwtVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
            - password
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
            - password
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
            - username
            - password
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
            expired_at:
              type: string
          required:
            - status
            - username
            - password
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateServiceAccountVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            application_id:
              type: string
            installation_id:
              type: string
            private_key:
              type: string
          required:
            - status
            - application_id
            - installation_id
            - private_key
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            application_id:
              type: string
            installation_id:
              type: string
            private_key:
              type: string
          required:
            - status
            - application_id
            - installation_id
            - private_key
      discriminator:
        propertyName: status
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemState:
      oneOf:
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - OAUTH1
              description: 'Discriminator value: OAUTH1'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth1Val
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - OAUTH2
              description: 'Discriminator value: OAUTH2'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateOauth2Val
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - API_KEY
              description: 'Discriminator value: API_KEY'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateApiKeyVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BASIC
              description: 'Discriminator value: BASIC'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateBasicVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BEARER_TOKEN
              description: 'Discriminator value: BEARER_TOKEN'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateBearerTokenVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - GOOGLE_SERVICE_ACCOUNT
              description: 'Discriminator value: GOOGLE_SERVICE_ACCOUNT'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateGoogleServiceAccountVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - NO_AUTH
              description: 'Discriminator value: NO_AUTH'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateNoAuthVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - CALCOM_AUTH
              description: 'Discriminator value: CALCOM_AUTH'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateCalcomAuthVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BILLCOM_AUTH
              description: 'Discriminator value: BILLCOM_AUTH'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateBillcomAuthVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BASIC_WITH_JWT
              description: 'Discriminator value: BASIC_WITH_JWT'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateBasicWithJwtVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - SERVICE_ACCOUNT
              description: 'Discriminator value: SERVICE_ACCOUNT'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStateServiceAccountVal
          required:
            - authScheme
            - val
      discriminator:
        propertyName: authScheme
    type_connectedAccounts:GetConnectedAccountsResponseItemsItemDeprecated:
      type: object
      properties:
        labels:
          type: array
          items:
            type: string
        uuid:
          type: string
          format: uuid
      required:
        - labels
        - uuid
    type_connectedAccounts:GetConnectedAccountsResponseItemsItem:
      type: object
      properties:
        toolkit:
          $ref: >-
            #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemToolkit
        auth_config:
          $ref: >-
            #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemAuthConfig
        id:
          type: string
        user_id:
          type: string
        status:
          $ref: >-
            #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemStatus
        created_at:
          type: string
        updated_at:
          type: string
        state:
          $ref: >-
            #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemState
        data:
          type: object
          additionalProperties:
            description: Any type
        status_reason:
          type: string
        is_disabled:
          type: boolean
        test_request_endpoint:
          type: string
        deprecated:
          $ref: >-
            #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItemDeprecated
      required:
        - toolkit
        - auth_config
        - id
        - user_id
        - status
        - created_at
        - updated_at
        - state
        - data
        - is_disabled
    type_connectedAccounts:GetConnectedAccountsResponse:
      type: object
      properties:
        items:
          type: array
          items:
            $ref: >-
              #/components/schemas/type_connectedAccounts:GetConnectedAccountsResponseItemsItem
        next_cursor:
          type: string
        total_pages:
          type: number
          format: double
        current_page:
          type: number
          format: double
        total_items:
          type: number
          format: double
      required:
        - items
        - total_pages
        - current_page
        - total_items

```

## SDK Code Examples

```javascript
const url = 'https://backend.composio.dev/api/v3/connected_accounts';
const options = {method: 'GET', headers: {'x-api-key': '<apiKey>'}};

try {
  const response = await fetch(url, options);
  const data = await response.json();
  console.log(data);
} catch (error) {
  console.error(error);
}
```

# Create a new connected account

POST https://backend.composio.dev/api/v3/connected_accounts
Content-Type: application/json

Reference: https://docs.composio.dev/api-reference/connected-accounts/post-connected-accounts

## OpenAPI Specification

```yaml
openapi: 3.1.1
info:
  title: Create a new connected account
  version: endpoint_connectedAccounts.postConnectedAccounts
paths:
  /api/v3/connected_accounts:
    post:
      operationId: post-connected-accounts
      summary: Create a new connected account
      tags:
        - - subpackage_connectedAccounts
      parameters:
        - name: x-api-key
          in: header
          required: true
          schema:
            type: string
      responses:
        '201':
          description: Successfully created connected account
          content:
            application/json:
              schema:
                $ref: >-
                  #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponse
        '400':
          description: Bad request
          content: {}
        '401':
          description: Unauthorized
          content: {}
        '404':
          description: Not found
          content: {}
        '500':
          description: Internal server error
          content: {}
        '501':
          description: Not implemented
          content: {}
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                auth_config:
                  $ref: >-
                    #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestAuthConfig
                connection:
                  $ref: >-
                    #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnection
              required:
                - auth_config
                - connection
components:
  schemas:
    type_connectedAccounts:PostConnectedAccountsRequestAuthConfig:
      type: object
      properties:
        id:
          type: string
      required:
        - id
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth1Val:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            oauth_token:
              type: string
            authUri:
              type: string
            oauth_token_secret:
              type: string
            redirectUrl:
              type: string
            callbackUrl:
              type: string
          required:
            - status
            - oauth_token
            - authUri
            - oauth_token_secret
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            oauth_token:
              type: string
            oauth_token_secret:
              type: string
            oauth_verifier:
              type: string
            consumer_key:
              type: string
            redirectUrl:
              type: string
            callback_url:
              type: string
          required:
            - status
            - oauth_token
            - oauth_token_secret
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            oauth_token:
              type: string
            oauth_token_secret:
              type: string
            oauth_verifier:
              type: string
            consumer_key:
              type: string
            redirectUrl:
              type: string
            callback_url:
              type: string
          required:
            - status
            - oauth_token
            - oauth_token_secret
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValActiveExpiresIn:
      oneOf:
        - type: number
          format: double
        - type: string
        - description: Any type
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValActiveScope:
      oneOf:
        - type: string
        - type: array
          items:
            type: string
        - description: Any type
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValActiveAuthedUser:
      type: object
      properties:
        access_token:
          type: string
        scope:
          type: string
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValInactiveExpiresIn:
      oneOf:
        - type: number
          format: double
        - type: string
        - description: Any type
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValInactiveScope:
      oneOf:
        - type: string
        - type: array
          items:
            type: string
        - description: Any type
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValInactiveAuthedUser:
      type: object
      properties:
        access_token:
          type: string
        scope:
          type: string
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2Val:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            code_verifier:
              type: string
            redirectUrl:
              type: string
            callback_url:
              type: string
            finalRedirectUri:
              type: string
            webhook_signature:
              type: string
          required:
            - status
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            access_token:
              type: string
            id_token:
              type: string
            token_type:
              type: string
            refresh_token:
              type: string
            expires_in:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValActiveExpiresIn
            scope:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValActiveScope
            webhook_signature:
              type: string
            authed_user:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValActiveAuthedUser
          required:
            - status
            - access_token
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            access_token:
              type: string
            id_token:
              type: string
            token_type:
              type: string
            refresh_token:
              type: string
            expires_in:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValInactiveExpiresIn
            scope:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValInactiveScope
            webhook_signature:
              type: string
            authed_user:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2ValInactiveAuthedUser
          required:
            - status
            - access_token
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateApiKeyVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            generic_api_key:
              type: string
            api_key:
              type: string
            bearer_token:
              type: string
            basic_encoded:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            generic_api_key:
              type: string
            api_key:
              type: string
            bearer_token:
              type: string
            basic_encoded:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateBasicVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateBearerTokenVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            token:
              type: string
          required:
            - status
            - token
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            token:
              type: string
          required:
            - status
            - token
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateGoogleServiceAccountVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            redirectUrl:
              type: string
            composio_link_redirect_url:
              type: string
          required:
            - status
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            credentials_json:
              type: string
          required:
            - status
            - credentials_json
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            credentials_json:
              type: string
          required:
            - status
            - credentials_json
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateNoAuthVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateCalcomAuthVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateBillcomAuthVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            redirectUrl:
              type: string
          required:
            - status
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            sessionId:
              type: string
            devKey:
              type: string
          required:
            - status
            - sessionId
            - devKey
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            sessionId:
              type: string
            devKey:
              type: string
          required:
            - status
            - sessionId
            - devKey
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateBasicWithJwtVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
            - password
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
            - password
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
            - username
            - password
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
            expired_at:
              type: string
          required:
            - status
            - username
            - password
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionStateServiceAccountVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            application_id:
              type: string
            installation_id:
              type: string
            private_key:
              type: string
          required:
            - status
            - application_id
            - installation_id
            - private_key
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            application_id:
              type: string
            installation_id:
              type: string
            private_key:
              type: string
          required:
            - status
            - application_id
            - installation_id
            - private_key
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsRequestConnectionState:
      oneOf:
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - OAUTH1
              description: 'Discriminator value: OAUTH1'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth1Val
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - OAUTH2
              description: 'Discriminator value: OAUTH2'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateOauth2Val
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - API_KEY
              description: 'Discriminator value: API_KEY'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateApiKeyVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BASIC
              description: 'Discriminator value: BASIC'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateBasicVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BEARER_TOKEN
              description: 'Discriminator value: BEARER_TOKEN'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateBearerTokenVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - GOOGLE_SERVICE_ACCOUNT
              description: 'Discriminator value: GOOGLE_SERVICE_ACCOUNT'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateGoogleServiceAccountVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - NO_AUTH
              description: 'Discriminator value: NO_AUTH'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateNoAuthVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - CALCOM_AUTH
              description: 'Discriminator value: CALCOM_AUTH'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateCalcomAuthVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BILLCOM_AUTH
              description: 'Discriminator value: BILLCOM_AUTH'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateBillcomAuthVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BASIC_WITH_JWT
              description: 'Discriminator value: BASIC_WITH_JWT'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateBasicWithJwtVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - SERVICE_ACCOUNT
              description: 'Discriminator value: SERVICE_ACCOUNT'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionStateServiceAccountVal
          required:
            - authScheme
            - val
      discriminator:
        propertyName: authScheme
    type_connectedAccounts:PostConnectedAccountsRequestConnection:
      type: object
      properties:
        state:
          $ref: >-
            #/components/schemas/type_connectedAccounts:PostConnectedAccountsRequestConnectionState
        data:
          type: object
          additionalProperties:
            description: Any type
        user_id:
          type: string
        callback_url:
          type: string
          format: uri
        redirect_uri:
          type: string
          format: uri
        deprecated_is_v1_rerouted:
          type: boolean
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth1Val:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            oauth_token:
              type: string
            authUri:
              type: string
            oauth_token_secret:
              type: string
            redirectUrl:
              type: string
            callbackUrl:
              type: string
          required:
            - status
            - oauth_token
            - authUri
            - oauth_token_secret
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            oauth_token:
              type: string
            oauth_token_secret:
              type: string
            oauth_verifier:
              type: string
            consumer_key:
              type: string
            redirectUrl:
              type: string
            callback_url:
              type: string
          required:
            - status
            - oauth_token
            - oauth_token_secret
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            oauth_token:
              type: string
            oauth_token_secret:
              type: string
            oauth_verifier:
              type: string
            consumer_key:
              type: string
            redirectUrl:
              type: string
            callback_url:
              type: string
          required:
            - status
            - oauth_token
            - oauth_token_secret
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValActiveExpiresIn:
      oneOf:
        - type: number
          format: double
        - type: string
        - description: Any type
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValActiveScope:
      oneOf:
        - type: string
        - type: array
          items:
            type: string
        - description: Any type
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValActiveAuthedUser:
      type: object
      properties:
        access_token:
          type: string
        scope:
          type: string
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValInactiveExpiresIn:
      oneOf:
        - type: number
          format: double
        - type: string
        - description: Any type
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValInactiveScope:
      oneOf:
        - type: string
        - type: array
          items:
            type: string
        - description: Any type
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValInactiveAuthedUser:
      type: object
      properties:
        access_token:
          type: string
        scope:
          type: string
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2Val:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            code_verifier:
              type: string
            redirectUrl:
              type: string
            callback_url:
              type: string
            finalRedirectUri:
              type: string
            webhook_signature:
              type: string
          required:
            - status
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            access_token:
              type: string
            id_token:
              type: string
            token_type:
              type: string
            refresh_token:
              type: string
            expires_in:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValActiveExpiresIn
            scope:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValActiveScope
            webhook_signature:
              type: string
            authed_user:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValActiveAuthedUser
          required:
            - status
            - access_token
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            access_token:
              type: string
            id_token:
              type: string
            token_type:
              type: string
            refresh_token:
              type: string
            expires_in:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValInactiveExpiresIn
            scope:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValInactiveScope
            webhook_signature:
              type: string
            authed_user:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2ValInactiveAuthedUser
          required:
            - status
            - access_token
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            state_prefix:
              type: string
            long_redirect_url:
              type: boolean
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataApiKeyVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            generic_api_key:
              type: string
            api_key:
              type: string
            bearer_token:
              type: string
            basic_encoded:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            generic_api_key:
              type: string
            api_key:
              type: string
            bearer_token:
              type: string
            basic_encoded:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataBasicVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataBearerTokenVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            token:
              type: string
          required:
            - status
            - token
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            token:
              type: string
          required:
            - status
            - token
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataGoogleServiceAccountVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            redirectUrl:
              type: string
            composio_link_redirect_url:
              type: string
          required:
            - status
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            credentials_json:
              type: string
          required:
            - status
            - credentials_json
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            credentials_json:
              type: string
          required:
            - status
            - credentials_json
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataNoAuthVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataCalcomAuthVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataBillcomAuthVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            redirectUrl:
              type: string
          required:
            - status
            - redirectUrl
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            sessionId:
              type: string
            devKey:
              type: string
          required:
            - status
            - sessionId
            - devKey
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            sessionId:
              type: string
            devKey:
              type: string
          required:
            - status
            - sessionId
            - devKey
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            expired_at:
              type: string
          required:
            - status
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataBasicWithJwtVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
            - password
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
          required:
            - status
            - username
            - password
        - type: object
          properties:
            status:
              type: string
              enum:
                - FAILED
              description: 'Discriminator value: FAILED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
            error:
              type: string
            error_description:
              type: string
          required:
            - status
            - username
            - password
        - type: object
          properties:
            status:
              type: string
              enum:
                - EXPIRED
              description: 'Discriminator value: EXPIRED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            username:
              type: string
            password:
              type: string
            expired_at:
              type: string
          required:
            - status
            - username
            - password
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionDataServiceAccountVal:
      oneOf:
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIALIZING
              description: 'Discriminator value: INITIALIZING'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - INITIATED
              description: 'Discriminator value: INITIATED'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
          required:
            - status
        - type: object
          properties:
            status:
              type: string
              enum:
                - ACTIVE
              description: 'Discriminator value: ACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            application_id:
              type: string
            installation_id:
              type: string
            private_key:
              type: string
          required:
            - status
            - application_id
            - installation_id
            - private_key
        - type: object
          properties:
            status:
              type: string
              enum:
                - INACTIVE
              description: 'Discriminator value: INACTIVE'
            subdomain:
              type: string
            your-domain:
              type: string
            region:
              type: string
            shop:
              type: string
            account_url:
              type: string
            COMPANYDOMAIN:
              type: string
            extension:
              type: string
            form_api_base_url:
              type: string
            instanceEndpoint:
              type: string
            api_url:
              type: string
            borneo_dashboard_url:
              type: string
            proxy_username:
              type: string
            proxy_password:
              type: string
            domain:
              type: string
            version:
              type: string
            dc:
              type: string
            site_name:
              type: string
            instanceName:
              type: string
            account_id:
              type: string
            your_server:
              type: string
            server_location:
              type: string
            base_url:
              type: string
            application_id:
              type: string
            installation_id:
              type: string
            private_key:
              type: string
          required:
            - status
            - application_id
            - installation_id
            - private_key
      discriminator:
        propertyName: status
    type_connectedAccounts:PostConnectedAccountsResponseConnectionData:
      oneOf:
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - OAUTH1
              description: 'Discriminator value: OAUTH1'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth1Val
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - OAUTH2
              description: 'Discriminator value: OAUTH2'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataOauth2Val
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - API_KEY
              description: 'Discriminator value: API_KEY'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataApiKeyVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BASIC
              description: 'Discriminator value: BASIC'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataBasicVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BEARER_TOKEN
              description: 'Discriminator value: BEARER_TOKEN'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataBearerTokenVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - GOOGLE_SERVICE_ACCOUNT
              description: 'Discriminator value: GOOGLE_SERVICE_ACCOUNT'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataGoogleServiceAccountVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - NO_AUTH
              description: 'Discriminator value: NO_AUTH'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataNoAuthVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - CALCOM_AUTH
              description: 'Discriminator value: CALCOM_AUTH'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataCalcomAuthVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BILLCOM_AUTH
              description: 'Discriminator value: BILLCOM_AUTH'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataBillcomAuthVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - BASIC_WITH_JWT
              description: 'Discriminator value: BASIC_WITH_JWT'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataBasicWithJwtVal
          required:
            - authScheme
            - val
        - type: object
          properties:
            authScheme:
              type: string
              enum:
                - SERVICE_ACCOUNT
              description: 'Discriminator value: SERVICE_ACCOUNT'
            val:
              $ref: >-
                #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionDataServiceAccountVal
          required:
            - authScheme
            - val
      discriminator:
        propertyName: authScheme
    type_connectedAccounts:PostConnectedAccountsResponseStatus:
      type: string
      enum:
        - value: INITIALIZING
        - value: INITIATED
        - value: ACTIVE
        - value: FAILED
        - value: EXPIRED
        - value: INACTIVE
    type_connectedAccounts:PostConnectedAccountsResponseDeprecated:
      type: object
      properties:
        uuid:
          type: string
          format: uuid
        authConfigUuid:
          type: string
          format: uuid
      required:
        - uuid
        - authConfigUuid
    type_connectedAccounts:PostConnectedAccountsResponse:
      type: object
      properties:
        id:
          type: string
        connectionData:
          $ref: >-
            #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseConnectionData
        status:
          $ref: >-
            #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseStatus
        redirect_url:
          type: string
        redirect_uri:
          type: string
        deprecated:
          $ref: >-
            #/components/schemas/type_connectedAccounts:PostConnectedAccountsResponseDeprecated
      required:
        - id
        - connectionData
        - status
        - deprecated

```

## SDK Code Examples

```javascript
const url = 'https://backend.composio.dev/api/v3/connected_accounts';
const options = {
  method: 'POST',
  headers: {'x-api-key': '<apiKey>', 'Content-Type': 'application/json'},
  body: '{"auth_config":{"id":"id"}}'
};

try {
  const response = await fetch(url, options);
  const data = await response.json();
  console.log(data);
} catch (error) {
  console.error(error);
}
```

# Delete a connected account

DELETE https://backend.composio.dev/api/v3/connected_accounts/{nanoid}

Soft-deletes a connected account by marking it as deleted in the database. This prevents the account from being used for API calls but preserves the record for audit purposes.

Reference: https://docs.composio.dev/api-reference/connected-accounts/delete-connected-accounts-by-nanoid

## OpenAPI Specification

```yaml
openapi: 3.1.1
info:
  title: Delete a connected account
  version: endpoint_connectedAccounts.deleteConnectedAccountsByNanoid
paths:
  /api/v3/connected_accounts/{nanoid}:
    delete:
      operationId: delete-connected-accounts-by-nanoid
      summary: Delete a connected account
      description: >-
        Soft-deletes a connected account by marking it as deleted in the
        database. This prevents the account from being used for API calls but
        preserves the record for audit purposes.
      tags:
        - - subpackage_connectedAccounts
      parameters:
        - name: nanoid
          in: path
          description: The unique identifier (nanoid) of the connected account
          required: true
          schema:
            type: string
        - name: x-api-key
          in: header
          required: true
          schema:
            type: string
      responses:
        '200':
          description: >-
            Successfully deleted the connected account. The account is marked as
            deleted but retained in the database for historical purposes.
          content:
            application/json:
              schema:
                $ref: >-
                  #/components/schemas/type_connectedAccounts:DeleteConnectedAccountsByNanoidResponse
        '400':
          description: Bad request - Invalid nanoid format or other validation error
          content: {}
        '401':
          description: Unauthorized - Authentication failed
          content: {}
        '403':
          description: >-
            Forbidden - Insufficient permissions to delete this connected
            account
          content: {}
        '404':
          description: >-
            Connected account not found - The specified account does not exist
            or has already been deleted
          content: {}
        '500':
          description: >-
            Internal server error - Failed to delete the connected account due
            to a server-side issue
          content: {}
components:
  schemas:
    type_connectedAccounts:DeleteConnectedAccountsByNanoidResponse:
      type: object
      properties:
        success:
          type: boolean
      required:
        - success

```

## SDK Code Examples

```javascript
const url = 'https://backend.composio.dev/api/v3/connected_accounts/con_1a2b3c4d5e6f';
const options = {method: 'DELETE', headers: {'x-api-key': '<apiKey>'}};

try {
  const response = await fetch(url, options);
  const data = await response.json();
  console.log(data);
} catch (error) {
  console.error(error);
}
```

---
title: Quickstart
image:
  type: url
  value: 'https://og.composio.dev/api/og?title=Quickstart'
description: Add authenticated tool-calling to any LLM agent in three steps.
keywords: ''
subtitle: ''
hide-nav-links: false
---

This guide walks you through **authenticated tool calling**—the foundation of how Composio connects your AI agents to real-world actions.

You'll learn how to:
1. **Discover and add tools** relevant to your use case (e.g., Slack, GitHub, Notion) to your AI agent
2. **Authenticate tools** securely on behalf of a specific user, with fine-grained access control
3. **Enable your LLM** (like OpenAI, Claude, or LangChain) to invoke these tools reliably using structured tool call formats

## Prerequisites

Before you begin, ensure you have:

1. **A Composio account** - [Sign up here](https://platform.composio.dev) if you haven't already
2. **Python 3.10+** or **Node.js 18+** installed on your system
3. **Your API key** - Get it from the [developer dashboard](https://platform.composio.dev?next_page=/settings) and set it as an environment variable:

```bash
export COMPOSIO_API_KEY=your_api_key
```

## Install the SDK
First, install the Composio SDK for your preferred language:

<CodeGroup>
```bash title="Python" for="python"
pip install composio
```
```bash title="TypeScript" for="typescript"
npm install @composio/core
```
</CodeGroup>

## Initialize the SDK
You’ll need to initialize the SDK with your Composio API key. This allows you to authenticate requests and access tools on behalf of your users.

<CodeGroup>
```python Python
from composio import Composio

composio = Composio(
  # api_key="your-api-key",
)
```
```typescript TypeScript
import { Composio } from '@composio/core';

// Initialize the SDK
const composio = new Composio({
  // apiKey: 'your-api-key',
});
```
</CodeGroup>


## Authorize Tools & Run Them with an Agent
Composio supports multiple LLM providers. Here’s how to use Composio with some of the most popular ones:
<Tabs>
<Tab title="OpenAI (Python)">
Composio ships with support for OpenAI provider out of the box.
```python Python title="Python" maxLines=40 
from composio import Composio
from openai import OpenAI

openai = OpenAI()
composio = Composio()
user_id = "user@email.com"

# Initialize connection request
connection_request = composio.toolkits.authorize(user_id=user_id, toolkit="gmail")
print(f"🔗 Visit the URL to authorize:\n👉 {connection_request.redirect_url}")

# wait for the connection to be active
connection_request.wait_for_connection()

# Fetch tools
tools = composio.tools.get(user_id=user_id, toolkits=["GMAIL"])

# Invoke agent
completion = openai.chat.completions.create(
    model="gpt-4o",
    messages=[
        {
            "role": "user",
            "content": "say 'hi from the composio quickstart' to soham@composio.dev",
            # we'll ship you free merch if you do ;)
        },
    ],
    tools=tools,
)

# Handle Result from tool call
result = composio.provider.handle_tool_calls(user_id=user_id, response=completion)
print(result)

```
</Tab>
<Tab title="Anthropic (Typescript)">
You may install the Anthropic provider as well!

**Installation**
```bash
npm install @composio/anthropic
```

```typescript TypeScript title="TypeScript" maxLines=40 
import { Composio } from '@composio/core';
import { AnthropicProvider } from '@composio/anthropic';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();
const composio = new Composio({ provider: new AnthropicProvider() });
const userId = 'user@example.com';

const connection = await composio.toolkits.authorize(userId, 'LINEAR');
console.log(`🔗 Visit the URL to authorize:\n👉 ${connection.redirectUrl}`);

const tools = await composio.tools.get(userId, { toolkits: ['LINEAR'] });
await connection.waitForConnection();

const msg = await anthropic.messages.create({
  model: 'claude-3-7-sonnet-latest',
  tools: tools,
  messages: [
    {
      role: 'user',
      content: 'Get my linear projects',
    },
  ],
  max_tokens: 1024,
});

const result = await composio.provider.handleToolCalls(userId, msg);
console.log('✅ Tool results:', result);

```

</Tab>
<Tab title="Vercel AI SDK (Typescript)">
You may install the Vercel AI provider as well!

**Installation**
```bash
npm install @composio/vercel
```

```typescript TypeScript title="TypeScript" maxLines=40 
import { Composio } from '@composio/core';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { VercelProvider } from '@composio/vercel';
import { v4 as uuidv4 } from 'uuid';

const userId = uuidv4(); // The user's ID.
const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,
  provider: new VercelProvider(),
});

const connection = await composio.toolkits.authorize(userId, 'gmail');
console.log(`🔗 Visit the URL to authorize:\n👉 ${connection.redirectUrl}`);

await connection.waitForConnection();

const tools = await composio.tools.get(userId, { tools: ['GMAIL_SEND_EMAIL'] });

const { text } = await generateText({
  model: anthropic('claude-3-7-sonnet-20250219'),
  prompt: "say 'hi from the composio quickstart' to soham.g@composio.dev", // we'll ship you free merch if you do ;)
  tools,
});

console.log(text);

```

</Tab>
<Tab title="OpenAI Agents (Python)">
You may install the OpenAI Agents provider as well!

**Installation**
```bash
pip install composio_openai_agents==0.8.0
```

```python Python title="Python" maxLines=40 
import asyncio

from agents import Agent, Runner

from composio import Composio
from composio_openai_agents import OpenAIAgentsProvider

# Initialize Composio toolset
user_id = "user@email.com"
composio = Composio(provider=OpenAIAgentsProvider(), api_key="your-composio-api-key")

# Initialize connection request
connection_request = composio.toolkits.authorize(user_id=user_id, toolkit="github")
print(f"🔗 Visit the URL to authorize:\n👉 {connection_request.redirect_url}")

# wait for the connection to be active
connection_request.wait_for_connection()

# Get all the tools
tools = composio.tools.get(
    user_id=user_id,
    tools=["GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER"],
)

# Create an agent with the tools
agent = Agent(
    name="GitHub Agent",
    instructions="You are a helpful assistant that helps users with GitHub tasks.",
    tools=tools,
)


# Run the agent
async def main():
    result = await Runner.run(
        starting_agent=agent,
        input=(
            "Star the repository composiohq/composio on GitHub. If done "
            "successfully, respond with 'Action executed successfully'"
        ),
    )
    print(result.final_output)


asyncio.run(main())

```

</Tab>
</Tabs>

<Note title="What just happened?">
You just:
1. Authorized a user account with Composio 
2. Passed those tool permissions into an LLM framework 
3. Let the LLM securely call real tools on the user’s behalf

All OAuth flows and tool execution were automatically handled by Composio.
</Note>


---
title: User Management
image:
  type: url
  value: 'https://og.composio.dev/api/og?title=User%20Management'
keywords: 'user management, user Id, user context, external user ID'
subtitle: Learn how to manage users for your application
hide-nav-links: false
---

## What are User IDs?
User IDs determine whose connected accounts and data you're accessing in Composio. Every tool execution, connection authorization, and account operation
requires a `userId` parameter that identifies which context to use.

User IDs act as containers that group connected accounts together across toolkits. Depending on your application, you can use User IDs to represent an
individual user, a team, or an entire organization.

## Quick Decision Guide

**How do users access connected accounts in your app?**

- **Each user connects their own personal accounts?**  
Use User IDs  
*Use your database UUID or primary key (e.g., `user.id`)*  
*Example: Users connect their personal Gmail, GitHub*

- **Teams share the same connected accounts?**  
Use Organization IDs  
*Use your organization UUID or primary key (e.g., `organization.id`)*  
*Example: Company Slack workspace*

## Patterns

### User IDs (Individual Accounts)

In production applications with multiple users, where each user connects and manages their own accounts.

**Choosing User IDs:**

- Recommended: Database UUID or primary key (`user.id`)
- Acceptable: Unique username (`user.username`)
- Avoid: Email addresses (emails can change)

<CodeGroup>
```typescript Typescript
// Use your database's user ID (UUID, primary key, etc.)
const userId = user.id; // e.g., "550e8400-e29b-41d4-a716-446655440000"

const tools = await composio.tools.get(userId, {
  toolkits: ['github'],
});

const result = await composio.tools.execute('GITHUB_GET_REPO', {
  userId: userId,
  arguments: { owner: 'example', repo: 'repo' },
});
```

```python Python
# Use your database's user ID (UUID, primary key, etc.)
user_id = user.id; # e.g., "550e8400-e29b-41d4-a716-446655440000"

tools = composio.tools.get(
  user_id=user_id,
  toolkits=["GITHUB"],
)

result = composio.tools.execute(
  "GITHUB_GET_REPO",
  user_id=user_id,
  arguments={ 
    "owner": 'example', 
    "repo": 'repo' 
  }
)
```

</CodeGroup>
<Warning>
Never use 'default' as an User ID in production with users. This could expose other users' data
</Warning>

### Organization IDs (Team Accounts)

For applications where teams share connections - one admin connects accounts, all team members use them.

**When to use:**
- Team tools: Slack, Microsoft Teams, Jira
- Shared accounts: support(at)company.com, company GitHub org
- Enterprise apps: IT manages connections for all employees

<CodeGroup>
```typescript TypeScript
// Use the organization ID as userId
const userId = organization.id; // e.g., "org_550e8400"

// All users in the organization share the same connected accounts
const tools = await composio.tools.get(userId, {
  toolkits: ['slack'],
});

// Execute tools in the organization context
const result = await composio.tools.execute('SLACK_SEND_MESSAGE', {
  userId: userId,
  arguments: {
    channel: '#general',
    text: 'Hello from the team!',
  },
});
```
```python Python
# Use the organization ID as userId  
user_id = organization.id # e.g., "org_550e8400"

# All users in the organization share the same connected accounts
tools = composio.tools.get(
  user_id=user_id,
  toolkits=["SLACK"],
)

# Execute tools in the organization context
result = composio.tools.execute(
  "SLACK_SEND_MESSAGE",
  user_id=user_id,
  arguments={ 
    "channel": '#general', 
    "text": 'Hello from the team!' 
  }
)
```
</CodeGroup>

## Multiple Connected Accounts

A single User ID can have multiple connected accounts for the same toolkit. For example, a user might connect both their personal and work Gmail accounts.

**Key concepts:**
- Each connected account gets a unique Connected Account ID
- Multiple accounts can exist under the same User ID for any toolkit
- You can specify which account to use when executing tools

**Account selection:**
- **Explicit:** Specify the Connected Account ID to target a specific account
- **Default:** If no Connected Account ID is provided, the most recently connected account is used 

## Examples
### Organization-Based Application

In B2B applications, typically an admin connects accounts once and all team members share access. Here's a complete implementation:

**Key concepts:**
- Admin performs the OAuth connection using organization ID
- All team members execute tools using the same organization ID
- Permission checks ensure users can only access their organization's connections
```typescript TypeScript
import { Composio } from '@composio/core';
const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,
});

// 1. Admin connects Slack for the entire organization
async function connectOrganizationToSlack(organizationId: string, adminUserId: string) {
  // Use organization ID as userId in Composio
  const connectionRequest = await composio.toolkits.authorize(organizationId, 'slack');
  
  // Store the connection request for the admin to complete
  await storeConnectionRequest(organizationId, adminUserId, connectionRequest);
  
  return connectionRequest.redirectUrl;
}

// 2. Any user in the organization can use the connected tools
async function sendSlackMessage(organizationId: string, channel: string, message: string) {
  return await composio.tools.execute('SLACK_SEND_MESSAGE', {
    userId: organizationId, // organization ID, not individual user ID
    arguments: {
      channel: channel,
      text: message,
    },
  });
}

// 3. Check if organization has required connections
async function getOrganizationTools(organizationId: string) {
  return await composio.tools.get(organizationId, {
    toolkits: ['slack', 'github', 'jira'],
  });
}

// Usage in your API endpoint
app.post('/api/slack/message', async (req, res) => {
  const { channel, message } = req.body;
  const organizationId = req.user.organizationId; // Get from your auth system
  
  // Verify user has permission to send messages for this organization
  // The userCanSendMessages function is your responsibility - implement it based on your application's permission model (role-based, feature flags, etc.).
  if (!(await userCanSendMessages(req.user.id, organizationId))) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  
  try {
    const result = await sendSlackMessage(organizationId, channel, message);
    res.json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});
```


### Multi-User Application

In B2C applications, each user connects and manages their own accounts. Every user goes through their own OAuth flow and their data remains completely isolated.

**Key concepts:**
- Each user authorizes their own accounts using their unique user ID
- Connections are isolated - users can only access their own connected accounts
- No permission checks needed since users only access their own data

```typescript TypeScript
import { Composio } from '@composio/core';
const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,
});

// 1. User initiates GitHub connection
async function connectUserToGitHub(userId: string) {
  const connectionRequest = await composio.toolkits.authorize(userId, 'github');
  return connectionRequest.redirectUrl;
}

// 2. Get user's connected GitHub tools
async function getUserGitHubTools(userId: string) {
  return await composio.tools.get(userId, {
    toolkits: ['github'],
  });
}

// 3. Execute tool for specific user
async function getUserRepos(userId: string) {
  return await composio.tools.execute('GITHUB_LIST_REPOS', {
    userId: userId,
    arguments: {
      per_page: 10,
    },
  });
}

// Usage in your API endpoint
app.get('/api/github/repos', async (req, res) => {
  const userId = req.user.id; // Get from your auth system
  
  try {
    const repos = await getUserRepos(userId);
    res.json(repos.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch repos' });
  }
});
```

**Data isolation**: Composio ensures each userId's connections and data are completely separate. User A can never access User B's repositories.

### Hybrid Pattern

Many applications need both personal and team resources. Users might connect their personal Gmail while sharing the company Slack workspace.

**Common scenarios:**
- Personal calendars + shared project management
- Individual GitHub accounts + organization repositories  

<CodeGroup>
```typescript TypeScript
// ❌ Wrong: Using individual user ID for org-connected tool
const userTools = await composio.tools.get(req.user.id, {
  toolkits: ['slack'], // Fails - Slack is connected at org level
});

// ✅ Correct: Match the ID type to how the tool was connected
const userPersonalTools = await composio.tools.get(req.user.id, {
  toolkits: ['gmail'], // User's personal Gmail
});

const orgSharedTools = await composio.tools.get(req.user.organizationId, {
  toolkits: ['slack', 'jira'], // Organization's shared tools
});
```
```python Python 
# ❌ Wrong: Using individual user ID for org-connected tool
user_tools = composio.tools.get(
    user_id="user_123",  # Individual user ID
    toolkits=["slack"]  # Fails - Slack is connected at org level
)

# ✅ Correct: Match the ID type to how the tool was connected
user_personal_tools = composio.tools.get(
    user_id="user_123",  # Individual user ID
    toolkits=["gmail"]  # User's personal Gmail
)

org_shared_tools = composio.tools.get(
    user_id="org_123",  # Organization ID
    toolkits=["slack", "jira"]  # Organization's shared tools  
)
```
</CodeGroup>
Remember: The userId must match how the account was connected. If admin connected Slack with org ID, all members must use org ID to access it.

## Best Practices

**Your responsibilities:**
- Pass the correct User ID for each user
- Verify user permissions before executing organization tools  
- Never use 'default' in production with multiple users
- Keep User IDs consistent across your application and Composio
- Use stable identifiers that won't change over time

**Data isolation:** Composio ensures complete isolation between User IDs. Users cannot access another ID's connections or data.
