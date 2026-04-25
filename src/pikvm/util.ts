/**
 * Cross-module helpers used by the pikvm/ implementation modules.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
