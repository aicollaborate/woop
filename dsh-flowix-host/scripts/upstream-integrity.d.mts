export const UPSTREAM_TREE_DIGEST: string
export const UPSTREAM_PATCH_DIGEST: string
export function treeDigest(root: string): Promise<string>
export function patchSetDigest(hostRoot: string, lock: { repository: string; commit: string; patches: string[] }): Promise<string>
export function isTrustedCheckout(root: string, requestedCommit: string, expectedPatchDigest: string): Promise<boolean>
