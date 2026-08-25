import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { FlowixDshBridgeClient } from '../bridge/client.ts'
import type { RuntimeSpec } from '../protocol/v1.ts'
import { runtimeLaunch } from './environment.ts'

/** Long-lived, session-free DSH runtime used only for settings and credentials. */
export class RuntimeAdmin {
  private active: Promise<{ harness: DeepSeekHarness; bridge: FlowixDshBridgeClient }> | undefined

  async credentialDescribe(reference: string) { return (await this.get()).bridge.credentialDescribe(reference) }
  async credentialSet(reference: string, value: string) { return (await this.get()).bridge.credentialSet(reference, value) }
  async credentialUnset(reference: string) { return (await this.get()).bridge.credentialUnset(reference) }
  async modelsDescribe() { return (await this.get()).bridge.modelsDescribe() }
  async modelsDiscover(request: Record<string, unknown>) { return (await this.get()).bridge.modelsDiscover(request) }
  async modelUpsert(route: string, profile: Record<string, unknown>, revision?: number) {
    return (await this.get()).bridge.modelUpsert(route, profile, revision)
  }
  async modelRemove(route: string, revision?: number) {
    return (await this.get()).bridge.modelRemove(route, revision)
  }

  async close(): Promise<void> {
    const active = this.active
    this.active = undefined
    if (active !== undefined) await (await active).harness.close()
  }

  private async get() {
    if (this.active === undefined) this.active = this.start().catch(error => { this.active = undefined; throw error })
    return await this.active
  }

  private async start() {
    const spec = adminRuntimeSpec()
    const launch = runtimeLaunch(spec)
    const harness = new DeepSeekHarness({
      launch: { command: launch.command, args: launch.args, cwd: spec.cwd, env: launch.env, requestTimeoutMs: 30_000, shutdownTimeoutMs: 1_500 },
      cwd: spec.cwd, workspacePaths: [], provider: spec.provider, model: spec.model,
    })
    const bridge = new FlowixDshBridgeClient(harness)
    ;(harness.client as unknown as { start(): void }).start()
    try {
      const negotiated = await bridge.capabilities()
      for (const capability of ['credentials-management', 'model-settings-management']) {
        if (!negotiated.capabilities.includes(capability as never)) throw new Error(`installed DSH bridge is missing ${capability}; update or reinstall DSH from Flowix`)
      }
      return { harness, bridge }
    } catch (error) {
      await harness.close()
      throw error
    }
  }
}

function adminRuntimeSpec(): RuntimeSpec {
  return {
    threadId: 'flowix-runtime-admin', cwd: process.cwd(), workspacePaths: [],
    provider: 'deepseek', providerName: 'DeepSeek', apiProtocol: 'openai-completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
    agentPreset: 'minimal', permissionMode: 'read-only',
  }
}
