/**
 * STUB: OpenAI Realtime STT provider — upstream file not yet in this merge.
 * TODO: Remove when upstream ships the real implementation.
 */
export class OpenAIRealtimeSTTProvider {
  // eslint-disable-next-line no-useless-constructor
  constructor(
    public readonly opts: {
      apiKey: string;
      model?: string;
      silenceDurationMs?: number;
      vadThreshold?: number;
    },
  ) {}
}
