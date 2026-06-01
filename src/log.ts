/**
 * Central logger. `debug()` messages are SILENT by default: the plugin doesn't
 * pollute the user's console. To diagnose, enable from Obsidian's developer
 * console:
 *
 *     window.__loreDebug = true
 *
 * `warn()` and `error()` are NOT gated — they signal real problems (broken
 * renderer API, exception in the rAF) and must stay visible.
 */
const PREFIX = "[Lore Graph]";

function debugEnabled(): boolean {
  return (window as typeof window & { __loreDebug?: boolean }).__loreDebug === true;
}

export function debug(...args: unknown[]): void {
  if (debugEnabled()) console.log(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}
