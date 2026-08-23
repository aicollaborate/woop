export const FLOWIX_REQUIRED_PROFILE_BUNDLES = [
  "@deepseek-ai/dsh-base",
  "@flowix/dsh-flowix-bridge",
  "dsh-flowix-memory",
] as const;

/** Keep Flowix's required layers ordered while preserving every valid
 * third-party bundle in its existing relative order. */
export function mergeFlowixProfileBundles(value: unknown): string[] {
  const required = new Set<string>(FLOWIX_REQUIRED_PROFILE_BUNDLES);
  const thirdParty = Array.isArray(value)
    ? value.filter(
        (bundle): bundle is string =>
          typeof bundle === "string" && !required.has(bundle),
      )
    : [];
  return [...FLOWIX_REQUIRED_PROFILE_BUNDLES, ...thirdParty];
}
