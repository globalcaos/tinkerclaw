#!/usr/bin/env node
/** Digital amygdala v2 - PostToolUse hook. All logic lives in lib.mjs. */
import { hookMain, runSeam } from "./lib.mjs";

hookMain(() => runSeam("post-tool"));
