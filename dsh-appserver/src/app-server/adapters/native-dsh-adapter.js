import { assistantChunkText, itemFromEvent, messageFromEvent, projectNotifications, projectTurns, stableItemId, stableTurnId, textOf, turnEndStatus } from './event-projector.js'

// Native adapter for Flowix's bundled DeepSeek Harness runtime.
// It deliberately imports no Flowix bridge package. The host supplies a Cordis ctx.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export class NativeDshAdapter {
  constructor(ctx) {
    this.ctx = ctx
    this.runtimes = new Map()
    this.history = new Map()
    this.pendingTurns = new Map()
    this.activeTurns = new Map()
    this.listeners = new Set()
    this.disposers = [
      ctx.on?.('session/event', (session, event) => { const threadId = String(session.id); this.history.set(threadId, [...(session.events || [])]); this.projectEvent(threadId, event) }),
      ctx.on?.('agent/status', payload => { const threadId = String(payload.agent.session.id); this.emit({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId, status: this.status(payload.status) } }) })
    ].filter(Boolean)
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(event) { for (const listener of this.listeners) listener(event) }
  projectEvent(threadId, event) {
    const turn = event.data?.turn
    if (event.type === 'turn/start') {
      const expected = this.pendingTurns.get(threadId)?.shift()
      const turnId = stableTurnId(threadId, turn ?? event.seq)
      if (expected && expected !== turnId) this.emit({ jsonrpc: '2.0', method: 'warning', params: { threadId, message: `Turn identity mismatch: expected ${expected}, received ${turnId}` } })
      this.activeTurns.set(threadId, turnId)
      this.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turnId, sourceSeq: event.seq, turn: { id: turnId, threadId, status: 'inProgress', items: [] } } })
      return
    }
    if (event.type === 'assistant/chunk') {
      const delta = assistantChunkText(event.data)
      if (delta !== undefined) {
        this.emit({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, turnId: this.activeTurns.get(threadId), itemId: stableItemId(threadId, event), sourceSeq: event.seq, delta } })
      }
      return
    }
    const item = itemFromEvent(threadId, event)
    if (item) {
      const turnId = this.activeTurns.get(threadId)
      this.emit({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, sourceSeq: event.seq, item } })
      if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'approval/decided') this.emit({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, sourceSeq: event.seq, item } })
    }
    if (event.type === 'turn/end') { const turnId = this.activeTurns.get(threadId) || stableTurnId(threadId, turn ?? event.seq); this.activeTurns.delete(threadId); this.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId, sourceSeq: event.seq, turn: { id: turnId, threadId, status: turnEndStatus(event.data), items: [] } } }) }
  }

  async startThread(id, config = {}) {
    const handle = await this.ctx.agents.create(this.agentCreateOptions(id, config))
    this.applyPermission(handle.agent, config.permissionMode)
    this.runtimes.set(String(handle.agent.session.id), handle)
    return this.thread(handle.agent)
  }

  async resumeThread(id, config = {}) {
    const existing = this.ctx.agents.get(id)
    if (existing) return this.thread(existing)
    const handle = await this.ctx.agents.resume(this.agentResumeOptions(id, config))
    this.applyPermission(handle.agent, config.permissionMode)
    this.runtimes.set(id, handle)
    return this.thread(handle.agent)
  }

  async forkThread(sourceId, boundarySeq, childId) {
    const source = this.ctx.sessions.get(sourceId) || (await this.resumeThread(sourceId), this.ctx.sessions.get(sourceId))
    if (!source) throw new Error(`Session not found: ${sourceId}`)
    const boundary = boundarySeq === undefined ? source.seq - 1 : boundarySeq
    if (!Number.isInteger(Number(boundary)) || Number(boundary) < -1 || Number(boundary) >= source.events.length) throw new Error(`Invalid fork boundary: ${boundary}`)
    const boundaryIndex = source.events.findIndex(event => Number(event.seq) === Number(boundary))
    const boundaryEvent = boundaryIndex >= 0 ? source.events[boundaryIndex] : undefined
    if (boundaryEvent && ['turn/start', 'step/start', 'agent/inbox/spliced'].includes(boundaryEvent.type)) throw new Error(`Cannot fork at a non-message boundary: ${boundary}`)
    // The UI exposes the final assistant/message as the fork point. In the
    // DSH event log its matching turn/end is normally the next event, so
    // cutting exactly at the message leaves the child with an open turn.
    // Finish that turn in the seed; otherwise the first follow-up can be
    // queued against a turn the runtime still considers active and produce no
    // notifications.
    let seedEnd = boundaryIndex >= 0 ? boundaryIndex : boundary
    if (boundaryEvent?.type === 'assistant/message') {
      const turnEndIndex = source.events.findIndex((event, index) => index > seedEnd && event.type === 'turn/end')
      if (turnEndIndex >= 0) seedEnd = turnEndIndex
    }
    const seed = source.events.slice(0, seedEnd + 1)
    const context = [...source.events].reverse().find(event => event.type === 'request/context')?.data || {}
    const agentPreset = source.header?.agentPreset || process.env.DSH_AGENT_PRESET?.trim() || 'standard'
    const presets = this.ctx.get?.('agentPresets')
    const agentOptions = typeof context.provider === 'string' && context.provider && typeof context.model === 'string' && context.model
      ? { provider: context.provider, model: context.model }
      : undefined
    const id = childId || `session-${Date.now()}`
    const handle = await this.ctx.agents.create({
      sessionId: id,
      seed,
      meta: { parentSession: sourceId, seedLength: seed.length, cwd: source.header?.cwd, agentPreset },
      ...(presets ? { setup: agentCtx => presets.mount(agentCtx, agentPreset) } : {}),
      ...(agentOptions ? { agentOptions } : {}),
    })
    this.runtimes.set(id, handle)
    return this.thread(handle.agent)
  }

  agentCreateOptions(id, config) {
    const agentPreset = this.agentPreset(config)
    const agentOptions = this.agentOptions(config)
    const presets = this.ctx.get?.('agentPresets')
    return {
      ...(typeof id === 'string' && id ? { sessionId: id } : {}),
      meta: {
        ...(typeof config.cwd === 'string' ? { cwd: config.cwd } : {}),
        ...(agentPreset ? { agentPreset } : {}),
        ...(Array.isArray(config.workspacePaths) ? { workspacePaths: config.workspacePaths } : {}),
      },
      ...(presets ? { setup: agentCtx => presets.mount(agentCtx, agentPreset) } : {}),
      ...(agentOptions ? { agentOptions } : {}),
    }
  }

  agentResumeOptions(id, config) {
    const agentPreset = this.agentPreset(config)
    const agentOptions = this.agentOptions(config)
    const presets = this.ctx.get?.('agentPresets')
    return {
      resumeSessionId: id,
      ...(presets ? { setup: agentCtx => presets.mount(agentCtx, agentPreset) } : {}),
      ...(agentOptions ? { agentOptions } : {}),
    }
  }

  agentPreset(config) { return typeof config.agentPreset === 'string' && config.agentPreset ? config.agentPreset : (process.env.DSH_AGENT_PRESET?.trim() || 'standard') }
  agentOptions(config) {
    if (typeof config.provider !== 'string' || !config.provider || typeof config.model !== 'string' || !config.model) return undefined
    return { provider: config.provider, model: config.model, ...(Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}) }
  }
  applyPermission(agent, permissionMode) {
    if (typeof permissionMode !== 'string' || !permissionMode) return
    const presets = this.ctx.get?.('permissionPresets')
    if (presets?.set) presets.set(agent.session, permissionMode)
  }

  async readThread(id, includeTurns = true) {
    const live = this.ctx.agents.get(id)
    if (live) return this.thread(live, includeTurns)
    const persistence = this.ctx.get?.('sessionPersistence')
    if (!persistence?.inspect) throw new Error('Session persistence is unavailable')
    const snapshot = await persistence.inspect(id)
    if (!snapshot) throw new Error(`Session not found: ${id}`)
    return this.snapshotThread(id, snapshot, includeTurns)
  }

  async listThreads() {
    const live = (this.ctx.sessions.list?.() || []).map(session => this.threadFromSession(session, false))
    const persistence = this.ctx.get?.('sessionPersistence')
    if (!persistence?.list) return live
    const records = await persistence.list()
    const known = new Set(live.map(thread => thread.id))
    for (const record of records || []) {
      const header = record?.header || record
      const id = header?.id ?? record?.id
      if (id != null && !known.has(String(id))) {
        live.push({ id: String(id), parentThreadId: header?.parentSession ? String(header.parentSession) : undefined, status: 'idle', turns: [] })
      }
    }
    return live
  }

  async listTurns(id, cursor = '0', limit = 50) {
    const thread = await this.readThread(id, true)
    const start = Math.max(0, Number.parseInt(cursor, 10) || 0)
    const data = thread.turns.slice(start, start + Math.min(200, Math.max(1, limit)))
    return { data, nextCursor: start + data.length < thread.turns.length ? String(start + data.length) : null }
  }
  async listEvents(id, afterSeq = -1, limit = 200) {
    const snapshot = await this.eventSnapshot(id)
    const events = (snapshot.events || []).filter(event => Number(event.seq) > Number(afterSeq)).slice(0, Math.min(1000, Math.max(1, Number(limit) || 200)))
    const next = events.length && Number(events[events.length - 1].seq) < (snapshot.events?.at(-1)?.seq ?? -1) ? String(events[events.length - 1].seq) : null
    return { data: events, nextCursor: next }
  }

  async eventSnapshot(id) {
    const persistence = this.ctx.get?.('sessionPersistence')
    let live
    try { live = this.ctx.sessions.get(id) } catch { /* the owning agent may have closed its scoped context */ }
    const snapshot = live ? { events: live.events } : await persistence?.inspect?.(id) || (this.history.has(id) ? { events: this.history.get(id) } : undefined)
    if (!snapshot) throw new Error(`Session not found: ${id}`)
    return snapshot
  }

  async replayNotifications(id, afterSeq = -1, limit = 200) {
    const snapshot = await this.eventSnapshot(id)
    const allEvents = snapshot.events || []
    const eventLimit = Math.min(1000, Math.max(1, Number(limit) || 200))
    const selected = allEvents.filter(event => Number(event.seq) > Number(afterSeq)).slice(0, eventLimit)
    if (!selected.length) return { data: [], nextCursor: null }
    const lastSeq = Number(selected.at(-1).seq)
    const notifications = projectNotifications(id, allEvents).filter(event => Number(event.params?.sourceSeq) > Number(afterSeq) && Number(event.params?.sourceSeq) <= lastSeq)
    const finalSeq = Number(allEvents.at(-1)?.seq ?? -1)
    return { data: notifications, nextCursor: lastSeq < finalSeq ? String(lastSeq) : null }
  }

  async startTurn(id, input) {
    const agent = await this.resolveAgent(id)
    const nextTurn = (agent.session.events || []).reduce((max, event) => Math.max(max, Number(event.data?.turn) || 0), 0) + 1
    const turnId = stableTurnId(id, nextTurn)
    const pending = this.pendingTurns.get(id) || []
    pending.push(turnId)
    this.pendingTurns.set(id, pending)
    const text = this.textFromInput(input)
    const message = { id: `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    agent.followup ? agent.followup(message) : agent.send(message, 'followup', true)
    return { id: turnId, threadId: id, status: 'inProgress', items: [] }
  }

  async interruptTurn(id) {
    const agent = this.ctx.agents.get(id)
    if (!agent) return { interrupted: false }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { interrupted: true }
  }

  activeTurnId(id) { return this.activeTurns.get(String(id)) ?? null }

  async findToolCall(id, callId) {
    if (!callId) return undefined
    const snapshot = await this.eventSnapshot(id)
    return [...(snapshot.events || [])].reverse().find(event => event.type === 'tool/call' && String(event.data?.callId) === String(callId))
  }

  async readApprovalPolicy(id) {
    const snapshot = await this.eventSnapshot(id)
    const event = [...(snapshot.events || [])].reverse().find(item => item.type === 'approval/policy')
    const fallback = this.ctx.get?.('approval')?.config?.policy || 'ask'
    return { threadId: id, policy: event?.data?.policy || fallback, source: event ? 'session' : 'default', supportedPolicies: ['ask', 'never'] }
  }

  async writeApprovalPolicy(id, policy) {
    if (!['ask', 'never'].includes(policy)) throw new Error('policy must be "ask" or "never"')
    const agent = await this.resolveAgent(id)
    const approval = this.ctx.get?.('approval')
    if (!approval?.setPolicy) throw new Error('DSH approval service is unavailable')
    approval.setPolicy(agent, policy)
    return this.readApprovalPolicy(id)
  }

  async closeThread(id) {
    const handle = this.runtimes.get(id)
    if (handle) { this.runtimes.delete(id); await handle.dispose(); return { closed: true } }
    return { closed: false }
  }

  async flush(id) {
    let session = this.runtimes.get(id)?.agent?.session
    if (!session) {
      try { session = this.ctx.agents.get(id)?.session } catch { /* an agent-owned scope may already be inactive */ }
    }
    if (!session) {
      try { session = this.ctx.sessions.get(id) } catch { /* an agent-owned session scope may already be inactive */ }
    }
    if (session) {
      try { return { flushed: await this.ctx.sessions.flush(session) } } catch { /* fall back to committed persistence below */ }
    }
    const snapshot = await this.ctx.get?.('sessionPersistence')?.inspect?.(id)
    if (!snapshot) throw new Error(`Session not found: ${id}`)
    return { flushed: true }
  }

  async ensureSession(id) {
    const live = this.ctx.agents.get(id)
    if (live) return this.thread(live)
    const persistence = this.ctx.get?.('sessionPersistence')
    if (persistence?.inspect) {
      const snapshot = await persistence.inspect(id)
      if (snapshot) return this.snapshotThread(id, snapshot, true)
    }
    return this.startThread(id)
  }

  async sessionHistory(id, { beforeSequence, snapshotSequence, limit = 50 } = {}) {
    const snapshot = await this.eventSnapshot(id)
    const all = snapshot.events || []
    const ceiling = Number.isInteger(Number(snapshotSequence)) ? Number(snapshotSequence) : Number(all.at(-1)?.seq ?? 0)
    const before = Number.isInteger(Number(beforeSequence)) ? Number(beforeSequence) : Number.POSITIVE_INFINITY
    const toolNames = new Map()
    for (const event of all) {
      if (event.type !== 'tool/call') continue
      const callId = event.data?.callId || event.data?.id
      const name = event.data?.name || event.data?.toolName
      if (callId && name) toolNames.set(String(callId), String(name))
    }
    const messages = all
      .filter(event => Number(event.seq) <= ceiling && Number(event.seq) < before)
      .map(event => messageFromEvent(id, event, toolNames))
      .filter(Boolean)
    const pageLimit = Math.min(200, Math.max(1, Number(limit) || 50))
    const page = messages.slice(-pageLimit)
    return {
      sessionId: id,
      messages: page,
      oldestSequence: page[0]?.sourceSeq ?? null,
      snapshotSequence: ceiling,
      hasMore: messages.length > page.length,
    }
  }

  async listJobs(id) {
    const agent = this.ctx.agents?.get?.(id)
    const jobs = this.ctx.get?.('jobs')
    if (!jobs?.list) return { jobs: [] }
    return { jobs: jobs.list(agent).map(job => ({
      id: String(job.id), kind: String(job.kind || 'job'), label: String(job.label || job.id),
      status: job.status, ...(job.detail === undefined ? {} : { detail: job.detail }),
      startedAt: job.startedAt, ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    })) }
  }

  async sessionUsage(id) {
    const snapshot = await this.eventSnapshot(id)
    const events = snapshot?.events || []
    const usage = events.filter(event => event.type === 'assistant/message' && event.data?.usage).reduce((total, event) => {
      const data = event.data.usage
      total.inputTokens += Number(data.inputTokens || data.input_tokens || 0)
      total.outputTokens += Number(data.outputTokens || data.output_tokens || 0)
      total.cacheReadTokens += Number(data.cacheReadTokens || data.cache_read_tokens || 0)
      total.cacheWriteTokens += Number(data.cacheWriteTokens || data.cache_write_tokens || 0)
      return total
    }, { sessionId: id, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: null, contextWindow: null, modelId: null })
    const context = [...events].reverse().find(event => event.type === 'request/context')?.data || {}
    usage.contextTokens = context.contextTokens ?? null
    usage.contextWindow = context.contextWindow ?? null
    usage.modelId = context.model ?? context.modelId ?? null
    return usage
  }

  listPlugins() {
    // Loader entries are the actual configured plugin rows. The inventory is
    // the public projection when that optional bundle is mounted. `ctx.registry`
    // is only a Cordis runtime registry: its values are runtime records, not
    // plugin manifests, so it cannot reliably provide an id/name.
    const loader = this.ctx.get?.('loader') || this.ctx.loader
    const loaderEntries = loader?.entries ? Array.from(loader.entries())
      .filter(entry => !entry.options?.group)
      .map(entry => ({
        id: entry.options?.id,
        entryId: entry.options?.id,
        moduleName: entry.options?.name,
        enabled: !entry.disabled,
      })) : []
    const profile = profilePlugins()
    const profileNames = new Set(profile.map(plugin => plugin.id))
    const hostEntries = loaderEntries.filter(entry => !profileNames.has(entry.moduleName) && !profileNames.has(entry.id))
    const inventory = this.ctx.get?.('pluginInventory')
    const inventoryEntries = inventory?.list?.()?.entries
    const registry = this.ctx.get?.('plugins') || this.ctx.get?.('pluginRegistry') || this.ctx.registry
    const entries = hostEntries.length > 0
      ? hostEntries
      : Array.isArray(inventoryEntries)
      ? inventoryEntries
      : registry?.list?.() || registry?.plugins || (registry?.values ? Array.from(registry.values()) : [])
    const plugins = Array.from(entries, (plugin, index) => {
      const inventoryEntry = typeof plugin === 'object' && plugin !== null && 'moduleName' in plugin
      const inventoryId = inventoryEntry ? plugin.moduleName : undefined
      const id = typeof plugin === 'string'
        ? plugin
        : String(plugin.id || inventoryId || plugin.name || plugin.pluginId || plugin.callback?.name || 'unknown')
      const name = typeof plugin === 'string'
        ? plugin
        : String(plugin.name || inventoryId || plugin.id || plugin.pluginId || plugin.callback?.name || 'unknown')
      const keyId = typeof plugin === 'object' && plugin !== null
        ? String(plugin.entryId || id)
        : id
      return {
        key: `host:${index}:${keyId}`,
        id,
        name,
        enabled: typeof plugin === 'string' || plugin.enabled !== false,
        toggleable: false,
        scope: 'host',
      }
    })
    const presets = presetPlugins()
    return {
      plugins: {
        platform: process.platform,
        host: plugins,
        presets,
        profile,
      },
    }
  }

  profileInfo() {
    return { profile: process.env.DSH_PROFILE || null, appServer: 'dsh-appserver', protocolVersion: 1 }
  }

  statusReport() {
    return { activeThreads: this.runtimes.size, threads: this.runtimes.size, initialized: true }
  }

  capabilitiesReport() {
    return { protocolVersion: 1, capabilities: ['runtime-events', 'session-control', 'session-dispose', 'run-cancel', 'profile', 'credentials-management', 'model-settings-management'] }
  }

  describeCredentials(reference) {
    const credentials = this.ctx.get?.('credentials')
    if (!credentials?.describe) throw new Error('DSH credentials service is unavailable')
    return credentials.describe(this.validateCredentialReference(reference))
  }

  async setCredential(reference, value) {
    const credentials = this.ctx.get?.('credentials')
    if (!credentials?.set) throw new Error('DSH credentials service is unavailable')
    const ref = this.validateCredentialReference(reference)
    if (typeof value !== 'string' || value === '') throw new Error('value must be a non-empty string')
    await credentials.set(ref, value)
    return this.describeCredentials(ref)
  }

  async unsetCredential(reference) {
    const credentials = this.ctx.get?.('credentials')
    if (!credentials?.unset) throw new Error('DSH credentials service is unavailable')
    const ref = this.validateCredentialReference(reference)
    await credentials.unset(ref)
    return this.describeCredentials(ref)
  }

  validateCredentialReference(reference) {
    if (typeof reference !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) throw new Error('reference must be an environment-variable name')
    return reference
  }

  describeModels() {
    const settings = this.ctx.get?.('settings')
    if (!settings?.describe) return { revision: 0, providers: {}, applies: [] }
    let descriptor
    try { descriptor = settings.describe({ redactSecrets: true }).find(item => item.ns === 'llm-pi-ai') } catch (_) { descriptor = undefined }
    if (!descriptor) return { revision: 0, providers: {}, applies: [] }
    const user = descriptor.user && typeof descriptor.user === 'object' && !Array.isArray(descriptor.user) ? descriptor.user : {}
    return { revision: descriptor.revision, providers: user.providers && typeof user.providers === 'object' && !Array.isArray(user.providers) ? user.providers : {}, applies: descriptor.applies }
  }

  /** Return configured routes in the provider-array shape used by clients. */
  catalogModels() {
    const configuration = this.describeModels()
    return {
      providers: Object.entries(configuration.providers).map(([provider, profile]) => ({
        provider,
        ...(typeof profile?.displayName === 'string' ? { displayName: profile.displayName } : {}),
        ...(typeof profile?.baseUrl === 'string' ? { baseUrl: profile.baseUrl } : {}),
        takesApiKey: true,
        models: Array.isArray(profile?.models)
          ? profile.models.filter(model => model && typeof model.id === 'string')
          : typeof profile?.model === 'string' && profile.model
            ? [{ id: profile.model }]
            : [],
      })),
    }
  }

  async discoverModels(request = {}) {
    const llm = this.ctx.get?.('llm')
    if (!llm?.discoverModels) throw new Error('DSH LLM discovery service is unavailable')
    return { models: await llm.discoverModels('llm-pi-ai', request && typeof request === 'object' ? request : {}) }
  }

  async configureModel(route, profile, expectedRevision) {
    this.validateRoute(route)
    const settings = this.ctx.get?.('settings')
    if (!settings?.mutate) throw new Error('DSH settings service is unavailable')
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('profile must be an object')
    this.validateRevision(expectedRevision)
    await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route], value: profile }], expectedRevision)
    return this.describeModels()
  }

  async deleteModel(route, expectedRevision) {
    this.validateRoute(route)
    const settings = this.ctx.get?.('settings')
    if (!settings?.mutate) throw new Error('DSH settings service is unavailable')
    this.validateRevision(expectedRevision)
    await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', route] }], expectedRevision)
    return this.describeModels()
  }

  validateRoute(route) {
    if (typeof route !== 'string' || route === '') throw new Error('route must be a non-empty string')
    if (route === '__proto__' || route === 'prototype' || route === 'constructor') throw new Error('invalid provider route')
  }

  validateRevision(revision) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new Error('expectedRevision must be a non-negative integer')
  }

  async resolveAgent(id) { return this.ctx.agents.get(id) || (await this.resumeThread(id), this.ctx.agents.get(id)) || (await this.startThread(id), this.ctx.agents.get(id)) }

  thread(agent, includeTurns = true) { return this.threadFromSession(agent.session, includeTurns, agent.status) }
  threadFromSession(session, includeTurns = true, status = 'idle') {
    const id = String(session.id)
    const messages = includeTurns ? session.deriveMessages?.() || [] : []
    return { id, parentThreadId: session.header?.parentSession ? String(session.header.parentSession) : undefined, status: this.status(status), turns: includeTurns ? projectTurns(id, session.events || [], messages) : [] }
  }
  snapshotThread(id, snapshot, includeTurns) { const events = snapshot.events || []; return { id, parentThreadId: snapshot.header?.parentSession ? String(snapshot.header.parentSession) : undefined, status: 'idle', turns: includeTurns ? projectTurns(id, events) : [] } }
  status(status) { return typeof status === 'string' && status.includes('run') ? 'running' : status === 'closed' ? 'closed' : 'idle' }
  textOf(value) { return textOf(value) }
  textFromInput(input) { if (typeof input === 'string') return input; if (Array.isArray(input)) { const text = input.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n'); return text || JSON.stringify(input) } return typeof input?.text === 'string' ? input.text : JSON.stringify(input) }
  dispose() {
    for (const dispose of this.disposers) dispose?.()
    for (const handle of this.runtimes.values()) void handle.dispose().catch(() => {})
    this.runtimes.clear()
    this.listeners.clear()
  }
}

function profilePlugins() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (!profileDir) return []
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles.filter(value => typeof value === 'string')
      : []
    return bundles.map((packageName, index) => {
      let name = packageName
      try {
        const packageManifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8'))
        name = packageManifest.description?.trim() || packageManifest.name?.trim() || packageName
      } catch (_) {}
      return {
        key: `profile:${index}:${packageName}`,
        id: packageName,
        name,
        enabled: true,
        toggleable: false,
        removable: false,
        scope: 'profile',
      }
    })
  } catch (_) {
    return []
  }
}

function disabledPluginKeys() {
  const path = process.env.FLOWIX_DSH_PLUGIN_SETTINGS_PATH
  if (!path) return new Set()
  try {
    const settings = JSON.parse(readFileSync(path, 'utf8'))
    return new Set(Array.isArray(settings?.disabled) ? settings.disabled.filter(value => typeof value === 'string') : [])
  } catch (_) {
    return new Set()
  }
}

function presetPlugins() {
  const root = presetRoot()
  if (!root) return {}
  const disabled = disabledPluginKeys()
  const result = {}
  for (const preset of ['standard', 'code', 'minimal', 'cordis']) {
    const source = join(root, preset, 'agent.cordis.yml')
    if (!existsSync(source)) continue
    result[preset] = parsePreset(source, preset, disabled)
  }
  return result
}

function presetRoot() {
  const configured = process.env.DSH_AGENT_PRESET_ROOT || process.env.FLOWIX_DSH_PRESET_ROOT
  if (configured) return configured
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'config', 'agent-presets')
  } catch (_) {
    return undefined
  }
}

function parsePreset(source, preset, disabled) {
  const rows = []
  let current
  const flush = () => {
    if (current && current.name && current.name !== 'cordis:group') {
      rows.push({
        key: `preset:${preset}:${rows.length}:${current.id}`,
        id: current.id,
        name: current.name,
        enabled: !current.disabled && !disabled.has(`preset:${preset}:${rows.length}:${current.id}`),
        toggleable: true,
        removable: false,
        scope: 'preset',
        preset,
      })
    }
    current = undefined
  }
  for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
    const idMatch = /^(\s*)- id:\s*(.+?)\s*$/.exec(line)
    if (idMatch) {
      flush()
      current = { id: cleanScalar(idMatch[2]), indent: idMatch[1].length }
      continue
    }
    if (!current) continue
    const nameMatch = /^(\s+)name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch && current.name === undefined && nameMatch[1].length > current.indent) {
      current.name = cleanScalar(nameMatch[2].replace(/^!!js\s+/, ''))
      continue
    }
    const disabledMatch = /^(\s+)disabled:\s*(.+?)\s*$/.exec(line)
    if (disabledMatch && disabledMatch[1].length > current.indent) {
      current.disabled = disabledMatch[2].trim() === 'true'
    }
  }
  flush()
  return rows
}

function cleanScalar(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
