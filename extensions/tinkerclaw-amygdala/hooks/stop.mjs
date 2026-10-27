#!/usr/bin/env node
/** Digital amygdala v2 - Stop hook (block JSON only). All logic lives in lib.mjs. */
import { hookMain, runSeam } from "./lib.mjs";

hookMain(() => runSeam("stop"));
