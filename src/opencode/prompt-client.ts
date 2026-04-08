import type {
  OpenCodePromptAsyncClient,
  PromptPartInput,
} from "../feishu/handlers/prompt.js";
import { logger as defaultLogger, type Logger } from "../utils/logger.js";

interface OpenCodeSessionPromptClient {
  session: {
    prompt(parameters: {
      sessionID: string;
      directory?: string;
      model?: { providerID: string; modelID: string };
      agent?: string;
      variant?: string;
      parts?: PromptPartInput[];
    }): Promise<unknown>;
  };
}

interface OpenCodePromptResult {
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorResult(value: unknown): value is OpenCodePromptResult {
  return isRecord(value) && "error" in value;
}

function summarizeParts(parts: PromptPartInput[] | undefined): string {
  return (parts ?? [])
    .map((part) => {
      if (part.type === "text") {
        return `text(len=${part.text.length})`;
      }

      return `file(mime=${part.mime},filename=${part.filename ?? "N/A"},urlScheme=${part.url.slice(0, 30)}...)`;
    })
    .join(", ");
}

export function createOpenCodePromptClient(
  openCodeClient: OpenCodeSessionPromptClient,
  logger: Logger = defaultLogger,
): OpenCodePromptAsyncClient {
  return {
    async promptAsync(parameters): Promise<void> {
      logger.debug(
        `[OpenCodePromptClient] Dispatching via session.prompt: parts=[${summarizeParts(parameters.parts)}]`,
      );

      const result = await openCodeClient.session.prompt({
        sessionID: parameters.sessionID,
        directory: parameters.directory,
        model: parameters.model,
        agent: parameters.agent,
        variant: parameters.variant,
        parts: parameters.parts,
      });

      if (hasErrorResult(result) && result.error) {
        throw result.error;
      }
    },
  };
}
