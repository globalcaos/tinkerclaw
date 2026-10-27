// The Jev client lives in core (src/infra/jev/) since THALAMUS v4; this file keeps the amygdala's old import path
// and pins the client's generics to the amygdala's own Situation and Question types.
import {
  JevClient as CoreJevClient,
  type JevClientOptions as CoreJevClientOptions,
} from "openclaw/plugin-sdk/fork-jev";
import type { Question, Situation } from "./types.js";

export {
  announceJev,
  configureJev,
  fetchTransport,
  fieldValues,
  jevOn,
  jevToken,
  noteJevBreaker,
  reportJevResult,
  setJevProbe,
  startJevWatch,
  toEntry,
  type JevTransport,
} from "openclaw/plugin-sdk/fork-jev";
export type JevClientOptions = CoreJevClientOptions<Situation, Question>;
export class JevClient extends CoreJevClient<Situation, Question> {}
