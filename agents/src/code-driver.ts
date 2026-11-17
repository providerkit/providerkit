/** The engine boundary. This contract does not load an optional runtime. */
export interface CodeDriver {
  /** Run once in a fresh sandbox and free it before settling. Program failures never reject. */
  run(job: CodeJob): Promise<CodeJobResult>;
}

export interface CodeJob {
  /** SDK-built JavaScript. Its value must be a string or a promise of a JSON envelope string. */
  script: string;
  /**
   * Exposed as __pk_call(name, input). Both arguments and the reply are strings.
   * The SDK checks tool names, JSON, byte limits, permissions and call budgets.
   * Return an error envelope for tool failures, not a rejected promise. Never retried.
   */
  call(name: string, input: string): Promise<string>;
  /** Exposed as __pk_log(text). The SDK caps and records the text. */
  log(text: string): void;
  /** Maximum guest heap allocation in bytes. */
  memoryBytes: number;
  /** Maximum guest stack in bytes. A driver may refuse an unsafe size. */
  stackBytes: number;
  /** Cumulative execution time in milliseconds, excluding asynchronous host waits. */
  cpuMs: number;
  /** Absolute wall deadline in epoch milliseconds, including admission and tool waits. */
  deadline: number;
  /** The SDK aborts its tool calls when this job ends. Cancellation cannot undo an effect. */
  signal: AbortSignal;
}

export type CodeJobResult =
  | { ok: true; envelope: string }
  | {
      ok: false;
      error: {
        name:
          | "SyntaxError"
          | "ProgramError"
          | "TimeoutError"
          | "CpuLimitError"
          | "MemoryLimitError"
          | "StackLimitError"
          | "AbortError"
          | "EngineError";
        message: string;
        /** Line in the SDK-built script. The SDK maps it back to the submitted code. */
        line?: number;
      };
    };
