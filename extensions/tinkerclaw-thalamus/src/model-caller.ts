// One model call for a fresh point: the digest reader, the checker, the writer (design doc section 6, units D3, D4).
//
// WHAT THIS IS FOR. Each of those is a short call to a model the router picked, by route key. Nothing here decides which
// model or whether to call; it makes the call, bounded in time and size, and returns the text or nothing. Nothing is
// thrown at the caller: a slow, failing or empty call is `undefined`, and the caller keeps what it had.
//
// THE DEFAULT goes through the gateway's own simple-completion path (`plugin-sdk/simple-completion-runtime`), loaded
// lazily, so it is ledgered like any other completion and uses whatever auth the gateway has for that provider. Tests
// pass their own `ModelCaller`; no test calls a model.

export type ModelRequest = {
  /** `provider/model`. */
  modelKey: string;
  /** Recorded with the decision. The completion path takes no effort setting, so it is not applied. */
  effort?: string;
  system?: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
};

export type ModelReply = { text: string; input?: number; output?: number };
export type ModelCaller = (req: ModelRequest) => Promise<ModelReply | undefined>;

/** The promise's value, or undefined if it takes longer than `ms` or rejects. */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(
          () => {
            onTimeout?.();
            resolve(undefined);
          },
          Math.max(1, ms),
        );
        timer.unref?.();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type CompletionRuntime = {
  prepareSimpleCompletionModelForAgent: (p: {
    cfg: never;
    agentId: string;
    modelRef?: string;
  }) => Promise<{ model: unknown; auth: unknown } | { error: string }>;
  completeWithPreparedSimpleCompletionModel: (p: {
    model: never;
    auth: never;
    context: unknown;
    options?: { maxTokens?: number; signal?: AbortSignal };
  }) => Promise<{
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input?: number; output?: number };
  }>;
};

export function createSdkModelCaller(o: {
  cfg: () => unknown;
  agentId?: string;
  load?: () => Promise<CompletionRuntime>;
}): ModelCaller {
  const load =
    o.load ??
    (() =>
      import("openclaw/plugin-sdk/simple-completion-runtime") as unknown as Promise<CompletionRuntime>);
  return async (req) => {
    const ac = new AbortController();
    const run = async (): Promise<ModelReply | undefined> => {
      const rt = await load();
      const prepared = await rt.prepareSimpleCompletionModelForAgent({
        cfg: o.cfg() as never,
        agentId: o.agentId ?? "main",
        modelRef: req.modelKey,
      });
      if ("error" in prepared) return undefined;
      const msg = await rt.completeWithPreparedSimpleCompletionModel({
        model: prepared.model as never,
        auth: prepared.auth as never,
        context: {
          ...(req.system ? { systemPrompt: req.system } : {}),
          messages: [{ role: "user", content: req.prompt, timestamp: Date.now() }],
        },
        options: { maxTokens: req.maxTokens, signal: ac.signal },
      });
      const text = (msg.content ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("")
        .trim();
      if (!text) return undefined;
      return {
        text,
        ...(msg.usage?.input !== undefined ? { input: msg.usage.input } : {}),
        ...(msg.usage?.output !== undefined ? { output: msg.usage.output } : {}),
      };
    };
    return withTimeout(run(), req.timeoutMs, () => ac.abort());
  };
}
