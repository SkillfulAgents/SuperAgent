// Split a command string into arguments, respecting quoted strings.
// e.g. 'get text "hello world"' -> ['get', 'text', 'hello world']
export function splitCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

// Build the final args array for a browser_run command.
// For 'eval', preserves the raw expression (including quotes) as a single argument.
// For other commands, uses splitCommandArgs for shell-style argument parsing.
export function buildRunCommandArgs(command: string): string[] {
  const commandArgs = splitCommandArgs(command);
  if (commandArgs.length === 0) return [];

  // For 'eval', pass everything after 'eval' as a single raw argument
  // to preserve JavaScript quotes (splitCommandArgs strips them).
  if (commandArgs[0] === 'eval') {
    const exprStart = command.indexOf('eval') + 4;
    const expr = command.slice(exprStart).trim();
    return expr ? ['eval', expr] : ['eval'];
  }

  return commandArgs;
}
