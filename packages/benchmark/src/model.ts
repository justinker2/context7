import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import type { ModelSpec, ProviderId } from "./types.js";

export function getModel(spec: ModelSpec): LanguageModel {
  switch (spec.provider) {
    case "anthropic":
      return anthropic(spec.modelId);
    case "openai":
      return openai(spec.modelId);
    case "google":
      return google(spec.modelId);
  }
}

export function parseModelArg(arg: string): ModelSpec {
  const [provider, ...rest] = arg.split(":");
  if (!provider || rest.length === 0) {
    throw new Error(`bad --model "${arg}", expected provider:modelId (e.g. anthropic:claude-sonnet-4-5)`);
  }
  const known: ProviderId[] = ["anthropic", "openai", "google"];
  if (!known.includes(provider as ProviderId)) {
    throw new Error(`unknown provider "${provider}", expected one of ${known.join(", ")}`);
  }
  return { provider: provider as ProviderId, modelId: rest.join(":") };
}
