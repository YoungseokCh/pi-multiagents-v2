/** Agent session lifecycle, scheduling, persistence, and mailbox coordination. */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
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
} from "@earendil-works/pi-coding-agent";
import {
  type AgentStatus,
  childPath,
  formatEnvelope,
  parseForkTurns,
  resolveTarget,
  selectForkMessages,
} from "./core.ts";
import { createCollaborationTools } from "./collaboration-tools.ts";

/** Canonical path of the primary agent. */
export const ROOT = "/root";
/** Tool names inherited by every spawned agent. */
const COLLABORATION_TOOLS = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
] as const;
/** Canonical extension entrypoint excluded from child resource loading. */
const SELF_PATH = safeRealpath(fileURLToPath(new URL("./index.ts", import.meta.url)));
/** Maximum number of child turns allowed to run concurrently. */
const MAX_CHILD_RUNS = positiveInteger(process.env.PI_MULTIAGENTS_MAX_CONCURRENCY, 8);
/** Pi custom-message type used for agent mail. */
const MAIL_TYPE = "pi-multiagents-v2-message";

/** Creates a named child session with the parent's persistence policy. */
export function createChildSessionManager(
  cwd: string,
  sourceSessionManager: Pick<SessionManager, "getSessionFile" | "getSessionDir">,
  path: string,
): SessionManager {
  const parentSession = sourceSessionManager.getSessionFile();
  const sessionManager = parentSession
    ? SessionManager.create(cwd, sourceSessionManager.getSessionDir(), { parentSession })
    : SessionManager.inMemory(cwd);
  sessionManager.appendSessionInfo(path);
  return sessionManager;
}

/** Parameters accepted by the spawn operation. */
interface SpawnParams {
  task_name: string;
  message: string;
  fork_turns?: string;
  agent_type?: string;
  model?: string;
  reasoning_effort?: ThinkingLevel;
}

/** Runtime state retained for one agent in the hierarchy. */
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

/** Parses a positive integer or returns a fallback. */
function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolves a real path while tolerating absent files. */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Returns the latest non-empty assistant text. */
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

/** Builds identity and collaboration guidance for a child agent. */
function subagentInstructions(path: string, parent: string, role?: string): string {
  return `
You are ${path}, an agent in a team collaborating on the user's task. Your direct parent is ${parent}.${role ? ` Your requested agent type is ${role}.` : ""}
You have an independent context window but share the same working directory and filesystem with every agent. You may spawn children with spawn_agent. Use disjoint write scopes and tell your parent which files you changed.
Use send_message for information that should not wake an idle agent and followup_task for new work that should start a turn. Your final response is automatically delivered to ${parent}; do not repeatedly poll or resend it.
Incoming team messages use NEW_TASK, MESSAGE, or FINAL_ANSWER envelopes. Canonical task names begin at /root.`;
}

/** Owns agent sessions, scheduling, messaging, and lifecycle state. */
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

  /** Creates a team rooted at `/root`. */
  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.nodes.set(ROOT, this.newNode(ROOT, null));
  }

  /** Initializes root state for the active Pi session. */
  start(ctx: ExtensionContext): void {
    this.cwd = ctx.cwd;
    this.projectTrusted = ctx.isProjectTrusted();
    const root = this.requireNode(ROOT);
    root.status = { completed: null };
  }

  /** Updates the root agent's externally visible status. */
  setRootStatus(status: AgentStatus): void {
    const root = this.nodes.get(ROOT);
    if (root) root.status = status;
  }

  /** Wakes root waiters when user input steers the current turn. */
  signalRootSteer(): void {
    this.signalActivity(ROOT, "steered");
  }

  /** Creates initial runtime state for an agent path. */
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

  /** Returns a known node or throws for an invalid path. */
  private requireNode(path: string): AgentNode {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`Agent not found: ${path}`);
    return node;
  }

  /** Resolves an agent reference and returns its node. */
  private resolve(current: string, target: string): AgentNode {
    return this.requireNode(resolveTarget(current, target));
  }

  /** Lazily creates the model runtime shared by child sessions. */
  private modelRuntime(): Promise<ModelRuntime> {
    return (this.modelRuntimePromise ??= ModelRuntime.create());
  }

  /** Reads the source agent messages available for context forking. */
  private sourceMessages(source: string, ctx: ExtensionContext): AgentMessage[] {
    if (source !== ROOT) return [...this.requireNode(source).session!.messages];
    return ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
  }

  /** Reads the active tools inherited from a source agent. */
  private sourceTools(source: string): string[] {
    return source === ROOT ? this.pi.getActiveTools() : this.requireNode(source).session!.getActiveToolNames();
  }

  /** Reads the model inherited from a source agent. */
  private sourceModel(source: string, ctx: ExtensionContext): Model<any> | undefined {
    return source === ROOT ? ctx.model : this.requireNode(source).session!.model;
  }

  /** Reads the reasoning level inherited from a source agent. */
  private sourceThinking(source: string, ctx: ExtensionContext): ThinkingLevel {
    return (source === ROOT ? ctx.thinkingLevel : this.requireNode(source).session!.thinkingLevel) ?? "off";
  }

  /** Creates and schedules a child agent session. */
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
      const sessionManager = createChildSessionManager(
        this.cwd,
        source === ROOT ? ctx.sessionManager : this.requireNode(source).session!.sessionManager,
        path,
      );
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

  /** Queues a task and schedules its agent when idle. */
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

  /** Starts queued child turns while concurrency is available. */
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

  /** Runs one child turn and forwards its terminal result. */
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

  /** Queues a non-waking message for an existing agent. */
  async sendMessage(source: string, target: string, message: string) {
    const recipient = this.resolve(source, target);
    await this.deliver(source, recipient.path, "MESSAGE", message, false);
    return { target: recipient.path, queued: true };
  }

  /** Assigns new work and starts or steers an existing child. */
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

  /** Delivers a model-visible message envelope to an agent mailbox. */
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
        { customType: MAIL_TYPE, content: envelope, display: false, details: { source, target, type } },
        { triggerTurn, deliverAs: "steer" },
      );
      return;
    }
    await recipient.session!.sendCustomMessage(
      { customType: MAIL_TYPE, content: envelope, display: false, details: { source, target, type } },
      { triggerTurn, deliverAs: recipient.running ? "steer" : "nextTurn" },
    );
  }

  /** Lists known agents, optionally below a resolved path prefix. */
  list(source: string, prefix?: string) {
    const resolvedPrefix = prefix ? resolveTarget(source, prefix) : undefined;
    return {
      agents: [...this.nodes.values()]
        .filter((node) => !resolvedPrefix || node.path === resolvedPrefix || node.path.startsWith(`${resolvedPrefix}/`))
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((node) => ({ agent_name: node.path, agent_status: node.status })),
    };
  }

  /** Interrupts a child turn while retaining its session. */
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

  /** Waits for mailbox activity, steering input, or timeout. */
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

  /** Records activity and resolves every waiter on an agent. */
  private signalActivity(path: string, activity: "mailbox" | "steered"): void {
    const node = this.nodes.get(path);
    if (!node) return;
    node.activityVersion++;
    node.lastActivity = activity;
    for (const waiter of [...node.waiters]) waiter(activity);
    node.waiters.clear();
  }

  /** Creates collaboration tools bound to a child identity. */
  private createTools(source: string) {
    return createCollaborationTools(this, source);
  }

  /** Aborts and disposes every child session. */
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

