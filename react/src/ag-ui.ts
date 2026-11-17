/** Portable AG-UI 1.0 mapping. The display protocol remains the package's wire.
 * Native events carry public text and activity. providerkit.display.v1 commits preserve
 * display-only semantics and host cursors; ignoring them is intentionally lossy.
 *
 * Protocol field evidence: TanStack AI packages/ai/src/utilities/spec-event-keys.ts (MIT,
 * Copyright (c) 2025 Tanner Linsley). Framing and approval conventions checked against
 * PydanticAI's ui/ag_ui adapter (MIT, Copyright Pydantic Services Inc. 2024 to present).
 * These are independently implemented mappings, not copied runtime implementations.
 */
export { createAgUiReader } from "./ag-ui/reader.ts";
export { createAgUiWriter } from "./ag-ui/writer.ts";
export { readResumeEntry, toResumeEntry, toProviderkitResumeEntry } from "./ag-ui/answers.ts";
export type { AgUiAnswerContext } from "./ag-ui/answers.ts";
export type {
  AgUiBase,
  AgUiBinding,
  AgUiEvent,
  AgUiInterrupt,
  AgUiIssue,
  AgUiLimits,
  AgUiMapping,
  AgUiMessage,
  AgUiOptions,
  AgUiOutcome,
  AgUiReader,
  AgUiReaderOptions,
  AgUiResumeEntry,
  AgUiWriter,
} from "./ag-ui/types.ts";
