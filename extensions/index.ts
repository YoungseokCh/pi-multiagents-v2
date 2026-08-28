import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  sessionEntryToContextMessages,
  SettingsManager,
  type ToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type AgentStatus,
  childPath,
  formatEnvelope,
  parseForkTurns,
  resolveTarget,
  selectForkMessages,
} from "./core.ts";

const ROOT = "/root";
const COLLABORATION_TOOLS = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
] as const;
const SELF_PATH = safeRealpath(fileURLToPath(import.meta.url));
const MAX_CHILD_RUNS = positiveInteger(process.env.PI_MULTIAGENTS_MAX_CONCURRENCY, 8);
const MAIL_TYPE = "pi-multiagents-v2-message";

const ROOT_INSTRUCTIONS = `
You are /root, the primary agent in a team of Pi agents.
Use spawn_agent for concrete, bounded work that can run independently while you continue useful local work. Child agents can recursively spawn their own children. All agents share the same working directory and filesystem, so give coding agents disjoint write scopes.
Use send_message to pass information without starting an idle agent, followup_task to give an existing non-root agent more work, wait_agent only when blocked on incoming work, list_agents to inspect the tree, and interrupt_agent to stop an agent's current turn. Child final answers are delivered automatically as FINAL_ANSWER messages.
Agent messages arrive in this form:
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>`;

interface SpawnParams {
  task_name: string;
  message: string;
  fork_turns?: string;
  agent_type?: string;
  model?: string;
  reasoning_effort?: ThinkingLevel;
}

interface AgentNode {
  path: string;
  parent: string | null;
  session?: AgentSession;
  status: AgentStatus;
  pendingTasks: string[];
  queued: boolean;
  running: boolean;
  interrupted: boolean;
  activityVersion: number;
  consumedActivityVersion: number;
  lastActivity: "mailbox" | "steered";
  waiters: Set<(activity: "mailbox" | "steered") => void>;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function lastAssistantText(messages: readonly AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

function toolResult<T>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function subagentInstructions(path: string, parent: string, role?: string): string {
  return `
You are ${path}, an agent in a team collaborating on the user's task. Your direct parent is ${parent}.${role ? ` Your requested agent type is ${role}.` : ""}
You have an independent context window but share the same working directory and filesystem with every agent. You may spawn children with spawn_agent. Use disjoint write scopes and tell your parent which files you changed.
Use send_message for information that should not wake an idle agent and followup_task for new work that should start a turn. Your final response is automatically delivered to ${parent}; do not repeatedly poll or resend it.
Incoming team messages use NEW_TASK, MESSAGE, or FINAL_ANSWER envelopes. Canonical task names begin at /root.`;
}

export class TeamManager {
  private readonly nodes = new Map<string, AgentNode>();
  private readonly reservedPaths = new Set<string>();
  private readonly runQueue: AgentNode[] = [];
  private modelRuntimePromise?: Promise<ModelRuntime>;
  private cwd = process.cwd();
  private activeChildRuns = 0;
  private disposed = false;
  private projectTrusted = false;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.nodes.set(ROOT, this.newNode(ROOT, null));
  }

  start(ctx: ExtensionContext): void {
    this.cwd = ctx.cwd;
    this.projectTrusted = ctx.isProjectTrusted();
    const root = this.requireNode(ROOT);
    root.status = { completed: null };
  }

  setRootStatus(status: AgentStatus): void {
    const root = this.nodes.get(ROOT);
    if (root) root.status = status;
  }

  signalRootSteer(): void {
    this.signalActivity(ROOT, "steered");
  }

  private newNode(path: string, parent: string | null): AgentNode {
    return {
      path,
      parent,
      status: "pending_init",
      pendingTasks: [],
      queued: false,
      running: false,
      interrupted: false,
      activityVersion: 0,
      consumedActivityVersion: 0,
      lastActivity: "mailbox",
      waiters: new Set(),
    };
  }

  private requireNode(path: string): AgentNode {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`Agent not found: ${path}`);
    return node;
  }

  private resolve(current: string, target: string): AgentNode {
    return this.requireNode(resolveTarget(current, target));
  }

  private modelRuntime(): Promise<ModelRuntime> {
    return (this.modelRuntimePromise ??= ModelRuntime.create());
  }

  private sourceMessages(source: string, ctx: ExtensionContext): AgentMessage[] {
    if (source !== ROOT) return [...this.requireNode(source).session!.messages];
    return ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
  }

  private sourceTools(source: string): string[] {
    return source === ROOT ? this.pi.getActiveTools() : this.requireNode(source).session!.getActiveToolNames();
  }

  private sourceModel(source: string, ctx: ExtensionContext): Model<any> | undefined {
    return source === ROOT ? ctx.model : this.requireNode(source).session!.model;
  }

  private sourceThinking(source: string, ctx: ExtensionContext): ThinkingLevel {
    return (source === ROOT ? ctx.thinkingLevel : this.requireNode(source).session!.thinkingLevel) ?? "off";
  }

  async spawn(source: string, params: SpawnParams, ctx: ExtensionContext) {
    if (this.disposed) throw new Error("Agent team is shutting down");
    const path = childPath(source, params.task_name);
    if (this.nodes.has(path) || this.reservedPaths.has(path)) {
      throw new Error(`Agent task already exists: ${path}; use followup_task to reuse it`);
    }

    const forkMode = parseForkTurns(params.fork_turns);
    if (forkMode === "all" && (params.model || params.reasoning_effort)) {
      throw new Error('Full-history forks inherit model and reasoning; use fork_turns="none" or a number for overrides');
    }

    this.reservedPaths.add(path);
    try {
      const runtime = await this.modelRuntime();
      const inheritedModel = this.sourceModel(source, ctx);
      let model = inheritedModel;
      if (params.model) {
        const slash = params.model.indexOf("/");
        const provider = slash >= 0 ? params.model.slice(0, slash) : inheritedModel?.provider;
        const modelId = slash >= 0 ? params.model.slice(slash + 1) : params.model;
        model = provider ? ctx.modelRegistry.find(provider, modelId) : undefined;
        if (!model) throw new Error(`Model not found: ${params.model}`);
      }
      if (!model) throw new Error("No model is available for the child agent");

      const forkedMessages = selectForkMessages(this.sourceMessages(source, ctx), params.fork_turns);
      const sessionManager = SessionManager.inMemory(this.cwd);
      for (const message of structuredClone(forkedMessages)) {
        sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
      }

      const settingsManager = SettingsManager.create(this.cwd, getAgentDir());
      const loader = new DefaultResourceLoader({
        cwd: this.cwd,
        agentDir: getAgentDir(),
        settingsManager,
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((extension) => {
            const isThisExtension =
              safeRealpath(extension.resolvedPath) === SELF_PATH ||
              (extension.tools.has("spawn_agent") && extension.tools.has("followup_task"));
            const isUntrustedProjectExtension = extension.sourceInfo.scope === "project" && !this.projectTrusted;
            return !isThisExtension && !isUntrustedProjectExtension;
          }),
        }),
        appendSystemPromptOverride: (base) => [
          ...base,
          subagentInstructions(path, source, params.agent_type?.trim() || undefined),
        ],
      });
      await loader.reload();

      const activeTools = [...new Set([...this.sourceTools(source), ...COLLABORATION_TOOLS])];
      const { session } = await createAgentSession({
        cwd: this.cwd,
        agentDir: getAgentDir(),
        modelRuntime: runtime,
        model,
        thinkingLevel: params.reasoning_effort ?? this.sourceThinking(source, ctx),
        tools: activeTools,
        customTools: this.createTools(path),
        resourceLoader: loader,
        sessionManager,
        settingsManager,
      });

      const node = this.newNode(path, source);
      node.session = session;
      this.nodes.set(path, node);
      try {
        await session.bindExtensions({ mode: "print" });
      } catch (error) {
        this.nodes.delete(path);
        session.dispose();
        throw error;
      }

      this.enqueue(node, formatEnvelope("NEW_TASK", path, source, params.message));
      return { task_name: path, status: node.status };
    } finally {
      this.reservedPaths.delete(path);
    }
  }

  private enqueue(node: AgentNode, task: string): void {
    node.pendingTasks.push(task);
    node.interrupted = false;
    if (!node.queued && !node.running) {
      node.queued = true;
      node.status = "pending_init";
      this.runQueue.push(node);
    }
    this.pump();
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.activeChildRuns < MAX_CHILD_RUNS && this.runQueue.length > 0) {
      const node = this.runQueue.shift()!;
      node.queued = false;
      const task = node.pendingTasks.shift();
      if (!task || node.running || !node.session) continue;
      void this.runNode(node, task);
    }
  }

  private async runNode(node: AgentNode, task: string): Promise<void> {
    node.running = true;
    node.status = "running";
    this.activeChildRuns++;
    try {
      await node.session!.prompt(task, { expandPromptTemplates: false });
      if (node.interrupted) {
        node.status = "interrupted";
      } else {
        const output = lastAssistantText(node.session!.messages);
        node.status = { completed: output };
        if (node.parent) {
          await this.deliver(node.path, node.parent, "FINAL_ANSWER", output ?? "(no output)", false).catch(() => undefined);
        }
      }
    } catch (error) {
      if (node.interrupted) {
        node.status = "interrupted";
      } else {
        const message = error instanceof Error ? error.message : String(error);
        node.status = { errored: message };
        if (node.parent) {
          await this.deliver(node.path, node.parent, "FINAL_ANSWER", `Agent error: ${message}`, false).catch(() => undefined);
        }
      }
    } finally {
      node.running = false;
      this.activeChildRuns--;
      if (!node.interrupted && node.pendingTasks.length > 0 && !node.queued) {
        node.queued = true;
        this.runQueue.push(node);
      }
      this.pump();
    }
  }

  async sendMessage(source: string, target: string, message: string) {
    const recipient = this.resolve(source, target);
    await this.deliver(source, recipient.path, "MESSAGE", message, false);
    return { target: recipient.path, queued: true };
  }

  async followup(source: string, target: string, message: string) {
    const recipient = this.resolve(source, target);
    if (recipient.path === ROOT) throw new Error("followup_task cannot target /root");
    const envelope = formatEnvelope("NEW_TASK", recipient.path, source, message);
    this.signalActivity(recipient.path, "mailbox");
    if (recipient.running) {
      await recipient.session!.sendCustomMessage(
        { customType: MAIL_TYPE, content: envelope, display: false, details: { source, target: recipient.path } },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } else {
      this.enqueue(recipient, envelope);
    }
    return { target: recipient.path, status: recipient.status };
  }

  private async deliver(
    source: string,
    target: string,
    type: "MESSAGE" | "FINAL_ANSWER",
    payload: string,
    triggerTurn: boolean,
  ): Promise<void> {
    if (this.disposed) return;
    const recipient = this.requireNode(target);
    const envelope = formatEnvelope(type, target, source, payload);
    this.signalActivity(target, "mailbox");
    if (target === ROOT) {
      this.pi.sendMessage(
        { customType: MAIL_TYPE, content: envelope, display: true, details: { source, target, type } },
        { triggerTurn, deliverAs: "steer" },
      );
      return;
    }
    await recipient.session!.sendCustomMessage(
      { customType: MAIL_TYPE, content: envelope, display: false, details: { source, target, type } },
      { triggerTurn, deliverAs: recipient.running ? "steer" : "nextTurn" },
    );
  }

  list(source: string, prefix?: string) {
    const resolvedPrefix = prefix ? resolveTarget(source, prefix) : undefined;
    return {
      agents: [...this.nodes.values()]
        .filter((node) => !resolvedPrefix || node.path === resolvedPrefix || node.path.startsWith(`${resolvedPrefix}/`))
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((node) => ({ agent_name: node.path, agent_status: node.status })),
    };
  }

  async interrupt(source: string, target: string) {
    const node = this.resolve(source, target);
    if (node.path === ROOT) throw new Error("/root is not a spawned agent");
    if (node.path === source) throw new Error("An agent cannot interrupt itself");
    const previousStatus = node.status;
    node.interrupted = true;
    node.pendingTasks.length = 0;
    node.session!.clearQueue();
    if (node.running) await node.session!.abort();
    node.status = "interrupted";
    return { previous_status: previousStatus };
  }

  async wait(source: string, timeoutMs: number | undefined, signal: AbortSignal | undefined) {
    const node = this.requireNode(source);
    if (node.activityVersion > node.consumedActivityVersion) {
      node.consumedActivityVersion = node.activityVersion;
      return { message: node.lastActivity === "steered" ? "Wait interrupted by new input." : "Wait completed.", timed_out: false };
    }

    const timeout = Math.min(Math.max(timeoutMs ?? 30_000, 100), 3_600_000);
    const activity = await new Promise<"mailbox" | "steered" | "timeout">((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const finish = (value: "mailbox" | "steered" | "timeout") => {
        clearTimeout(timer);
        node.waiters.delete(onActivity);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onActivity = (value: "mailbox" | "steered") => finish(value);
      const onAbort = () => {
        clearTimeout(timer);
        node.waiters.delete(onActivity);
        reject(new Error("wait_agent aborted"));
      };
      node.waiters.add(onActivity);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish("timeout"), timeout);
      if (signal?.aborted) onAbort();
    });

    if (activity !== "timeout") node.consumedActivityVersion = node.activityVersion;
    return {
      message: activity === "timeout" ? "Wait timed out." : activity === "steered" ? "Wait interrupted by new input." : "Wait completed.",
      timed_out: activity === "timeout",
    };
  }

  private signalActivity(path: string, activity: "mailbox" | "steered"): void {
    const node = this.nodes.get(path);
    if (!node) return;
    node.activityVersion++;
    node.lastActivity = activity;
    for (const waiter of [...node.waiters]) waiter(activity);
    node.waiters.clear();
  }

  private createTools(source: string): ToolDefinition[] {
    return createCollaborationTools(this, source);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.runQueue.length = 0;
    const children = [...this.nodes.values()].filter((node) => node.session);
    for (const node of children) {
      node.interrupted = true;
      node.pendingTasks.length = 0;
    }
    await Promise.all(
      children.map((node) =>
        node.session!
          .abort()
          .catch(() => undefined)
          .finally(() => node.session!.dispose()),
      ),
    );
    for (const node of children) node.status = "shutdown";
  }
}

function createCollaborationTools(team: TeamManager, source: string): ToolDefinition[] {
  const spawnAgent = defineTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Spawn an agent for a concrete, bounded subtask. The child gets a canonical path, independent context, shared filesystem, the same active tools, and recursive delegation tools.",
    promptSnippet: "Spawn a child agent for independent parallel work",
    parameters: Type.Object(
      {
        task_name: Type.String({ description: "Lowercase letters, digits, and underscores" }),
        message: Type.String({ description: "Initial task for the child" }),
        fork_turns: Type.Optional(Type.String({ description: '"none", "all" (default), or a positive integer string' })),
        agent_type: Type.Optional(Type.String({ description: "Optional role instruction" })),
        model: Type.Optional(Type.String({ description: "Optional provider/model override for non-full forks" })),
        reasoning_effort: Type.Optional(
          StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return toolResult(await team.spawn(source, params, ctx));
    },
  });

  const sendMessage = defineTool({
    name: "send_message",
    label: "Send Message",
    description: "Queue a message for an existing agent. It does not start a new turn for an idle agent.",
    promptSnippet: "Send information to a running agent without waking an idle one",
    parameters: Type.Object(
      { target: Type.String({ description: "Relative child name or canonical task path" }), message: Type.String() },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return toolResult(await team.sendMessage(source, params.target, params.message));
    },
  });

  const followupTask = defineTool({
    name: "followup_task",
    label: "Follow-up Task",
    description: "Give an existing non-root agent another task, starting it if idle or steering it if running.",
    promptSnippet: "Give an existing agent more work and trigger its turn",
    parameters: Type.Object(
      { target: Type.String({ description: "Relative child name or canonical task path" }), message: Type.String() },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return toolResult(await team.followup(source, params.target, params.message));
    },
  });

  const waitAgent = defineTool({
    name: "wait_agent",
    label: "Wait Agent",
    description: "Wait for mailbox activity, steered user input, or timeout. Actual mailbox content arrives separately in context.",
    promptSnippet: "Wait for agent mail only when blocked on it",
    parameters: Type.Object(
      { timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })) },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal) {
      return toolResult(await team.wait(source, params.timeout_ms, signal));
    },
  });

  const listAgents = defineTool({
    name: "list_agents",
    label: "List Agents",
    description: "List agents and their latest status, optionally below a task-path prefix.",
    promptSnippet: "Inspect the current hierarchical agent tree",
    parameters: Type.Object(
      { path_prefix: Type.Optional(Type.String({ description: "Relative or canonical task path" })) },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return toolResult(team.list(source, params.path_prefix));
    },
  });

  const interruptAgent = defineTool({
    name: "interrupt_agent",
    label: "Interrupt Agent",
    description: "Interrupt a spawned agent's current turn while preserving its context for future follow-up tasks.",
    promptSnippet: "Stop a child agent's current turn without deleting it",
    parameters: Type.Object(
      { target: Type.String({ description: "Relative child name or canonical task path" }) },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return toolResult(await team.interrupt(source, params.target));
    },
  });

  return [spawnAgent, sendMessage, followupTask, waitAgent, listAgents, interruptAgent];
}

export default function subagentsV2(pi: ExtensionAPI) {
  const team = new TeamManager(pi);
  for (const tool of createCollaborationTools(team, ROOT)) pi.registerTool(tool);

  pi.on("session_start", (_event, ctx) => team.start(ctx));
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt.includes("You are /root, the primary agent in a team of Pi agents.")
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${ROOT_INSTRUCTIONS}`,
  }));
  pi.on("agent_start", () => team.setRootStatus("running"));
  pi.on("agent_settled", () => team.setRootStatus({ completed: null }));
  pi.on("input", (event) => {
    if (event.streamingBehavior === "steer") team.signalRootSteer();
  });
  pi.on("session_shutdown", async () => team.dispose());
}
