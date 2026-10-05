#!/usr/bin/env node
/** Digital amygdala v2 - UserPromptSubmit hook. All logic lives in lib.mjs. */
import { hookMain, runSeam } from "./lib.mjs";

hookMain(() => runSeam("prompt"));
