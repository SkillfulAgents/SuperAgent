I am thinking of refactoring how we handle connected OAuth accounts. Right now, the agent asks for an account, and we provide the access token as an env var. This has two issues:
1. Access tokens can expire, and we have no way to refresh them.
2. The agent has the raw access token, which is a security risk.

I am thinking of a new approach whereby instead of providing raw access, we provide a synthetic token and a custom endpoint that points back to a proxy server managed by the main app. So when the containerized agent wants to make an API request to service X, insteado of going to api.servicex.com with a legitimate access token, it'l go to localhost:PORT/proxy/servicex/...path with a synthetic token. Our proxy will validate the synthetic token, look up the real access token from the DB (refreshing with composio if needed), and make the request on behalf of the agent. This way, we can also handle refreshing access tokens when they expire.

I want your opinion on this approach, and any suggestions you have to improve it.
A few considerations:
- We want to minimize complexity, so ideally the proxy server should be as simple as possible and run in the main app process.
- We will need to change the instructions and data passed to the containerized agent to use the proxy endpoint and synthetic token.
- We can generate a synthetic token per agent (container) that can be used across different services. That way when we connect a new account, we don't need to pass any new data to the container, just update the mapping in the main app.
- The execution plan should involve a thorough testing plan to ensure we have robust testing around token refresh and proxying logic.