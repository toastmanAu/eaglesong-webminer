/**
 * cpu-worker.js — browser Web Worker entry point (bundled to an IIFE by
 * scripts/build-single-file.mjs and started from a Blob URL).
 */
import { attachWorker } from './cpu-worker-core.js';

attachWorker(self);
