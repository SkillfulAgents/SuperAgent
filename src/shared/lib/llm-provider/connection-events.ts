/**
 * On the notifications stream when the server changes a saved connection by
 * itself, outside any request that asked for it: a sign-in it could not
 * refresh now needs reconnecting, or a local model server's catalog sync
 * changed the models listed. A window that lists connections reads them
 * again; one that changed a connection through a request refreshes from that.
 *
 * Its own file, with no imports, so the renderer can name it.
 */
export const LLM_CONNECTIONS_CHANGED_EVENT = 'llm_connections_changed'
