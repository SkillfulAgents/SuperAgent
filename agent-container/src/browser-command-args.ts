import { validatePressKey } from './press-key';

// Split a command string into arguments, respecting quoted strings.
// e.g. 'get text "hello world"' -> ['get', 'text', 'hello world']
//
// Model-written commands are not shell input, so this deliberately deviates
// from shell semantics in two ways (browser-tools audit F2 — the old strip-
// everything tokenizer shipped corrupted text to live sites):
//
// 1. A quote with no matching closer is a LITERAL character, not an open
//    group: `type @e1 chat isn't enough` keeps the apostrophe instead of
//    swallowing it and the rest of the line.
// 2. A quoted span that does not cover a whole token keeps its quote marks:
//    `frame iframe[title="Secure payment input frame"]` must reach
//    querySelector with the quotes intact (stripping them produces invalid
//    CSS). Only classic whole-token quoting (`fill @e1 "hello world"`) strips.
//
// Backslash escapes \" \' \\ produce the literal character.
export function splitCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let i = 0;

  const pushCurrent = () => {
    if (current) {
      args.push(current);
      current = '';
    }
  };

  // Find the matching closer for the quote at `open`, skipping escaped quotes.
  const findCloser = (quote: string, open: number): number => {
    for (let j = open + 1; j < command.length; j++) {
      if (command[j] === '\\') {
        j++;
      } else if (command[j] === quote) {
        return j;
      }
    }
    return -1;
  };

  while (i < command.length) {
    const ch = command[i];

    if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === "'" || command[i + 1] === '\\')) {
      current += command[i + 1];
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const close = findCloser(ch, i);
      if (close === -1) {
        // Unpaired quote (apostrophes in prose): literal character.
        current += ch;
        i++;
        continue;
      }
      const startsToken = current === '';
      const endsToken = close + 1 >= command.length || command[close + 1] === ' ' || command[close + 1] === '\t';
      const inner = command.slice(i + 1, close).replace(/\\(["'\\])/g, '$1');
      if (startsToken && endsToken) {
        // Whole-token quoting: group and strip, classic shell style.
        current += inner;
      } else {
        // Quotes inside a token (CSS attribute selectors): group but keep them.
        current += ch + inner + ch;
      }
      i = close + 1;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      pushCurrent();
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  pushCurrent();
  return args;
}

// Resolve a browser_run request into the final argv for the agent-browser CLI.
// Accepts either a command STRING (tokenized via buildRunCommandArgs) or a
// pre-tokenized args ARRAY. The array form is preferred whenever any argument
// contains spaces or quotes: elements reach the CLI verbatim, so there is no
// tokenization and no escaping to get wrong.
export function resolveRunCommandArgs(input: { command?: unknown; args?: unknown }):
  | { args: string[]; error?: undefined }
  | { args?: undefined; error: string } {
  const hasCommand = typeof input.command === 'string' && input.command.trim() !== '';
  const hasArgs = input.args !== undefined && input.args !== null;

  if (hasArgs) {
    if (hasCommand) {
      return { error: 'Provide either "command" or "args", not both' };
    }
    if (!Array.isArray(input.args) || input.args.length === 0 || !input.args.every(a => typeof a === 'string')) {
      return { error: '"args" must be a non-empty array of strings, e.g. ["fill", "@e1", "hello world"]' };
    }
    if (input.args[0].trim() === '') {
      return { error: 'args[0] must be an agent-browser command verb (e.g. "fill", "get", "find")' };
    }
    return { args: input.args };
  }

  if (!hasCommand) {
    return { error: 'A "command" string or "args" array is required' };
  }
  const args = buildRunCommandArgs(input.command as string);
  if (args.length === 0) {
    return { error: 'Empty command' };
  }
  return { args };
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

// Why browser_run refuses one CLI command, or null.
function refuseCommand(command: string[]): string | null {
  const verb = command[0]?.toLowerCase();
  // The agent-browser CLI `upload` command does not work reliably in this
  // environment — refuse it and steer the model to `browser_upload`, which
  // routes through the buffer-based path with size verification.
  if (verb === 'upload') {
    return 'Use the `browser_upload(filePath, selector)` MCP tool for file uploads instead of `browser_run("upload …")`.';
  }
  // A HAR written by the CLI itself carries the session's cookies and
  // tokens unredacted, to wherever the agent points it.
  if (verb === 'network' && command[1]?.toLowerCase() === 'har') {
    return 'Use the `browser_capture_traffic` tool to record traffic: it saves a HAR with cookies, tokens and auth headers redacted. `network har` through browser_run is not available.';
  }
  // Same guard as /browser/press for the raw CLI form: `press` with a
  // non-key string silently types nothing while reporting success.
  if (verb === 'press' && command.length === 2) return validatePressKey(command[1]);
  return null;
}

// Why browser_run refuses a command, or null. `batch` runs each of its
// arguments as a command of its own, so each one gets the same checks.
export function runCommandRefusal(commandArgs: string[]): string | null {
  const commands = commandArgs[0]?.toLowerCase() === 'batch'
    ? commandArgs.slice(1).filter((arg) => !arg.startsWith('-')).map(splitCommandArgs)
    : [commandArgs];
  for (const command of commands) {
    const refusal = refuseCommand(command);
    if (refusal) return refusal;
  }
  return null;
}
