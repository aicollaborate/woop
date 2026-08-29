import { agent, deepseekHarness } from "@platform/tauri/client";
import type { AgentTypeKey } from "@/types/agent";
import type { BadgeHoverCardRuntimeInfo } from "../badge-hover-card";

/**
 * 按 agent 类型构造 BadgeHoverCard 的 runtime info 懒加载请求器。
 *
 * - threadId 统一在调用时通过 getThreadId 重新读取, 避免闭包捕获到
 *   会话线程 id 解析前的陈旧值;
 * - threadId 为空时直接返回 null, 不向后台发 invoke;
 * - 未适配的 agent 类型返回 undefined, 与组件"无懒加载"语义一致。
 */
export function createRuntimeInfoRequester(
  typeKey: AgentTypeKey,
  getThreadId: () => string | null | undefined,
): (() => Promise<BadgeHoverCardRuntimeInfo | null>) | undefined {
  switch (typeKey) {
    case "deepseek-harness":
      return () => {
        const threadId = getThreadId();
        return threadId
          ? deepseekHarness.sessionUsage(threadId)
          : Promise.resolve(null);
      };
    case "opencode":
      return async () => {
        const threadId = getThreadId();
        if (!threadId) return null;
        return {
          sessionId: (await agent.getOpenCodeSessionId(threadId)) ?? undefined,
          usage: {},
        };
      };
    case "codex":
      return async () => {
        const threadId = getThreadId();
        // Account and rate-limit data are global Codex runtime metadata and
        // are available before a conversation has created a provider
        // session. Only per-thread usage needs a session id.
        const sessionId = threadId
          ? await agent.getCodexSessionId(threadId)
          : null;
        const info = await agent.getCodexRuntimeInfo(sessionId);
        return {
          sessionId: sessionId ?? undefined,
          usage: info.usage ?? {},
          codex: info,
        };
      };
    default:
      return undefined;
  }
}
