import { initializeMemoLibrary } from '@features/memo/use-cases/initialize-memo-library';
import { restorePersistedMemoSession } from '@features/memo/use-cases/open-memo-session';
import { restoreAgentConversationWorkspace } from '@features/workspace/use-cases/agent-conversation-navigation';

/**
 * Run the main-window startup stages in one failure-aware transaction.
 *
 * Memo library initialization is the prerequisite for restoring a persisted
 * memo session. Keeping the stages together means a retry follows the same
 * order as the initial boot and never restores a document against stale
 * notebook state.
 */
export async function initializeMainWindowStartup(): Promise<void> {
  await initializeMemoLibrary();
  await restorePersistedMemoSession();
  await restoreAgentConversationWorkspace();
}
