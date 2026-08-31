/** Pure types and helpers for agent paths, context forks, and message envelopes. */

/** Lifecycle state exposed for an agent node. */
export type AgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "shutdown"
  | "not_found"
  | { completed: string | null }
  | { errored: string };

/** Message kinds exchanged between collaborating agents. */
export type MessageEnvelopeType = "NEW_TASK" | "MESSAGE" | "FINAL_ANSWER";

/** Minimal message shape needed to build a child context fork. */
type ForkableMessage = {
  role: string;
  content?: unknown;
  toolCallId?: string;
};

/** Builds and validates a canonical child path. */
export function childPath(parent: string, taskName: string): string {
  if (!/^[a-z0-9_]+$/.test(taskName)) {
    throw new Error("task_name must contain only lowercase letters, digits, and underscores");
  }
  return `${parent}/${taskName}`;
}

/** Resolves a relative or absolute agent reference. */
export function resolveTarget(current: string, target: string): string {
  const value = target.trim();
  if (!value) throw new Error("target cannot be empty");
  if (value === "root" || value === "/root") return "/root";
  return value.startsWith("/") ? value : `${current}/${value}`;
}

/** Parses the requested parent-history fork mode. */
export function parseForkTurns(value: string | undefined): "none" | "all" | number {
  const normalized = value?.trim().toLowerCase() || "all";
  if (normalized === "none" || normalized === "all") return normalized;
  const count = Number(normalized);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('fork_turns must be "none", "all", or a positive integer string');
  }
  return count;
}

/** Extracts tool-call identifiers from an assistant message. */
function toolCallIds(message: ForkableMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: unknown; id?: unknown };
    return item.type === "toolCall" && typeof item.id === "string" ? [item.id] : [];
  });
}

/** Remove a trailing assistant tool-call batch when its results do not exist yet. */
export function removeIncompleteTail<T extends ForkableMessage>(messages: readonly T[]): T[] {
  const copy = [...messages];
  let assistantIndex = -1;
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === "assistant") {
      assistantIndex = i;
      break;
    }
  }
  if (assistantIndex < 0) return copy;

  const calls = toolCallIds(copy[assistantIndex]);
  if (calls.length === 0) return copy;
  const results = new Set(
    copy.slice(assistantIndex + 1).flatMap((message) =>
      message.role === "toolResult" && typeof message.toolCallId === "string" ? [message.toolCallId] : [],
    ),
  );
  return calls.every((id) => results.has(id)) ? copy : copy.slice(0, assistantIndex);
}

/** Selects the complete messages copied into a child session. */
export function selectForkMessages<T extends ForkableMessage>(
  messages: readonly T[],
  forkTurns: string | undefined,
): T[] {
  const mode = parseForkTurns(forkTurns);
  if (mode === "none") return [];
  const complete = removeIncompleteTail(messages);
  if (mode === "all") return complete;

  const userIndexes = complete.flatMap((message, index) => (message.role === "user" ? [index] : []));
  if (userIndexes.length <= mode) return complete;
  return complete.slice(userIndexes[userIndexes.length - mode]);
}

/** Formats a model-visible inter-agent message envelope. */
export function formatEnvelope(
  type: MessageEnvelopeType,
  recipient: string,
  author: string,
  payload: string,
): string {
  return `Message Type: ${type}\nTask name: ${recipient}\nSender: ${author}\nPayload:\n${payload}`;
}
