/**
 * 给新创建的 AgentConversationInstance 填一份"初始 runtime_config"。
 *
 * 新模型下文件区域 (cwd / folders) 由「当前笔记本的资料列表 + 当前笔记本」
 * 在提交时实时推导 (见 agent-runtime-spec::buildAgentRuntimeConfig +
 * primary-workspace::resolvePrimaryWorkspace), 不再烧录进 instance 快照,
 * 也不再有冻结 / seed 机制。
 *
 * 这里只种子 model / access / reasoningEffort 的全局默认, 以及创建时所属
 * notebookId ── 提交时据此 resolveDefaultFiles(config, notebookId) 取该
 * 笔记本的资料默认 (defaults.files[<notebookId>])。 未选笔记本时 notebookId
 * 为 undefined, 提交侧 defaultFiles 为 undefined, 主空间回落当前笔记本路径。
 */
import type { AgentTypeKey, RuntimeConfig } from "@/types/agent";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useMemoStore } from "@features/memo/store/memo-store";

export function buildInitialInstanceRuntimeConfig(
  agentType: AgentTypeKey = "flowix",
): RuntimeConfig {
  const accessState = useAgentAccessStore.getState();
  const notebookId = useMemoStore.getState().selectedNotebook?.id ?? undefined;
  const defaultRuntime = accessState.config.defaults?.runtime?.[agentType];

  return {
    ...(defaultRuntime?.model ? { model: defaultRuntime.model } : {}),
    ...(defaultRuntime?.access ? { access: defaultRuntime.access } : {}),
    ...(defaultRuntime?.reasoningEffort
      ? { reasoningEffort: defaultRuntime.reasoningEffort }
      : {}),
    notebookId,
  };
}
