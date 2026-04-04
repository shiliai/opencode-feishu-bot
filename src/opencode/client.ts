import {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeClientConfig,
} from "@opencode-ai/sdk/v2";
import { getConfig, type OpenCodeConfig } from "../config.js";

export function buildOpenCodeClientConfig(
  opencodeConfig: OpenCodeConfig,
): OpencodeClientConfig {
  return {
    baseUrl: opencodeConfig.apiUrl,
    headers: opencodeConfig.apiKey
      ? { Authorization: `Bearer ${opencodeConfig.apiKey}` }
      : undefined,
  };
}

export function createOpenCodeClient(
  opencodeConfig: OpenCodeConfig = getConfig().opencode,
): OpencodeClient {
  return createOpencodeClient(buildOpenCodeClientConfig(opencodeConfig));
}

export const opencodeClient = createOpenCodeClient();
