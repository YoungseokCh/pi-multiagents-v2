/** Pi tool definitions that expose collaboration operations to each agent. */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TeamManager } from "./team-manager.ts";

/** Wraps a structured collaboration result for Pi and the model. */
function toolResult<T>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

/** Creates collaboration tools bound to one sending agent. */
export function createCollaborationTools(team: TeamManager, source: string): ToolDefinition[] {
  /** Spawns a child agent with an independent context. */
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

  /** Queues information without waking an idle recipient. */
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

  /** Assigns new work and starts or steers the recipient. */
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

  /** Waits for mailbox or steering activity. */
  const waitAgent = defineTool({
    name: "wait_agent",
    label: "Wait Agent",
    description: "Wait for mailbox activity, steered user input, or timeout. Actual mailbox content arrives separately in context.",
    promptSnippet: "Wait for agent mail only when blocked on it",
    renderShell: "self",
    parameters: Type.Object(
      { timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })) },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal) {
      return toolResult(await team.wait(source, params.timeout_ms, signal));
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("muted", "• Waiting for agents"), 0, 0);
    },
    renderResult(_result, _options, theme, context) {
      const message = context.isError ? theme.fg("error", "• Wait failed") : theme.fg("muted", "• Finished waiting");
      return new Text(`\n${message}`, 0, 0);
    },
  });

  /** Lists known agents and their latest states. */
  const listAgents = defineTool({
    name: "list_agents",
    label: "List Agents",
    description: "List agents and their latest status, optionally below a task-path prefix.",
    promptSnippet: "Inspect the current hierarchical agent tree",
    renderShell: "self",
    parameters: Type.Object(
      { path_prefix: Type.Optional(Type.String({ description: "Relative or canonical task path" })) },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return toolResult(team.list(source, params.path_prefix));
    },
    renderCall() {
      return new Container();
    },
    renderResult() {
      return new Container();
    },
  });

  /** Interrupts a spawned agent while retaining its session. */
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
