import { openUrl } from '@platform/tauri/opener';
import type { AgentTypeKey } from '@/types/agent';
import { isAgentTypeComingSoon } from '@/lib/agent-types';

const AGENT_SETUP_URLS: Partial<Record<AgentTypeKey, string>> = {
  codex: 'https://developers.openai.com/codex/cli',
  claude: 'https://code.claude.com/docs/en/setup',
  gemini: 'https://google-gemini.github.io/gemini-cli/docs/cli/headless.html',
  hermes: 'https://hermes-agent.nousresearch.com/docs/user-guide/cli',
  openclaw: 'https://docs.openclaw.ai/cli',
  opencode: 'https://opencode.ai/docs/cli/',
};

export async function openAgentSetup(typeKey: AgentTypeKey): Promise<void> {
  if (isAgentTypeComingSoon(typeKey)) return;

  const url = AGENT_SETUP_URLS[typeKey];
  if (url) {
    await openUrl(url);
  }
}
