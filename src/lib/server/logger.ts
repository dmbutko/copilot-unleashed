import { config } from './config.js';

/**
 * Dev-only debug logger — calls are no-ops in production.
 * Avoids noisy `[DEBUG …]` lines flooding container logs.
 */
export const debug: (...args: unknown[]) => void =
  config.isDev
    ? (...args: unknown[]) => console.log(...args)
    : () => {};
