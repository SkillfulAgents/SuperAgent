import { spawn, ChildProcess } from 'child_process';
import { SDKMessage, SDKUserMessage } from './types';
import { EventEmitter } from 'events';

export class ClaudeCodeProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private sessionId: string;
  private workingDirectory: string;
  private claudeSessionId: string | null;
  private buffer: string = '';
  private isReady: boolean = false;

  constructor(
    sessionId: string,
    workingDirectory: string,
    claudeSessionId?: string
  ) {
    super();
    this.sessionId = sessionId;
    this.workingDirectory = workingDirectory;
    this.claudeSessionId = claudeSessionId || null;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Spawn Claude Code process in non-interactive mode with JSON I/O
        // Inherit environment naturally from parent process
        const isResuming = !!this.claudeSessionId;
        console.log(`[Session ${this.sessionId}] ANTHROPIC_API_KEY set:`, !!process.env.ANTHROPIC_API_KEY);
        console.log(`[Session ${this.sessionId}] Working directory:`, this.workingDirectory);
        console.log(`[Session ${this.sessionId}] Resuming:`, isResuming, this.claudeSessionId);

        // Build args - add --resume if we have a Claude session ID
        const args = [
          '--print',
          '--verbose',
          '--output-format', 'stream-json',
          '--input-format', 'stream-json',
          '--include-partial-messages',
          '--replay-user-messages',
          '--dangerously-skip-permissions',
        ];

        if (isResuming) {
          args.push('--resume', this.claudeSessionId!);
        }

        this.process = spawn('claude', args, {
          cwd: this.workingDirectory,
          stdio: ['pipe', 'pipe', 'pipe'],
          // No env option - inherit naturally from parent process
        });

        // Handle stdout - parse JSON responses
        this.process.stdout?.on('data', (data: Buffer) => {
          const output = data.toString();
          console.log(`[Session ${this.sessionId}] stdout:`, output);
          this.handleOutput(output);
        });

        // Handle stderr
        this.process.stderr?.on('data', (data: Buffer) => {
          const error = data.toString();
          console.error(`[Session ${this.sessionId}] stderr:`, error);
          this.emit('stderr', error);
        });

        // Also log stdout for debugging
        console.log(`[Session ${this.sessionId}] Spawning Claude with command:`, 'claude', [
          '--print',
          '--verbose',
          '--output-format', 'stream-json',
          '--input-format', 'stream-json',
          '--include-partial-messages',
          '--replay-user-messages',
          '--dangerously-skip-permissions',
        ].join(' '));

        let startupComplete = false;

        // Handle process exit
        this.process.on('exit', (code: number | null) => {
          console.log(`[Session ${this.sessionId}] Process exited with code ${code}`);
          this.emit('exit', code);
          this.isReady = false;

          // If process exits during startup with error, reject
          if (!startupComplete && code !== 0) {
            reject(new Error(`Claude Code exited with code ${code} during startup`));
          }
        });

        // Handle process errors
        this.process.on('error', (error: Error) => {
          console.error(`[Session ${this.sessionId}] Process error:`, error);
          reject(error);
        });

        // Wait a moment for the process to initialize
        setTimeout(() => {
          // Check if process is still running
          if (this.process && this.process.exitCode === null) {
            startupComplete = true;
            this.isReady = true;
            this.emit('ready');
            resolve();
          } else {
            reject(new Error(`Claude Code process terminated during startup`));
          }
        }, 1000);
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleOutput(data: string): void {
    // Add new data to buffer
    this.buffer += data;

    // Try to extract complete JSON objects
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const parsed: SDKMessage = JSON.parse(line);

          // Capture Claude session ID from init message
          if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
            this.claudeSessionId = parsed.session_id;
            console.log(`[Session ${this.sessionId}] Captured Claude session ID:`, this.claudeSessionId);
            this.emit('claude-session-id', this.claudeSessionId);
          }

          // Emit the SDK message directly
          this.emit('message', parsed);
        } catch (error) {
          // If it's not valid JSON, log and skip
          console.warn(`[Session ${this.sessionId}] Non-JSON output:`, line);
        }
      }
    }
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.process || !this.isReady) {
      throw new Error('Claude Code process is not running');
    }

    // Convert to the format expected by Claude Code streaming JSON input
    const input: SDKUserMessage = {
      type: 'user',
      session_id: this.claudeSessionId || this.sessionId,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: content,
          },
        ],
      },
      parent_tool_use_id: null,
    };

    const inputStr = JSON.stringify(input);
    console.log(`[Session ${this.sessionId}] Sending to stdin:`, inputStr);

    // Write to stdin with newline
    this.process.stdin?.write(inputStr + '\n');
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      this.process.once('exit', () => {
        resolve();
      });

      // Try graceful shutdown first
      this.process.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  isRunning(): boolean {
    return this.process !== null && this.isReady;
  }
}
