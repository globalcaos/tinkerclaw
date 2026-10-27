#!/usr/bin/env node
/** Digital amygdala v2 - PreToolUse hook (local hard-rule floor first). All logic lives in lib.mjs. */
import { hookMain, runSeam } from "./lib.mjs";

hookMain(() => runSeam("pre-tool"));
