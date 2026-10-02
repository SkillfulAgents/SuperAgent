/**
 * The Todo board's query key, on its own so hooks that change what the board
 * shows (deleting a session or an agent) can refresh it without importing
 * use-todos, which imports them.
 */
export const TODOS_QUERY_KEY = ['todos'] as const
