/** Pi extension entrypoint that wires Multi-Agent V2 tools and lifecycle hooks. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCollaborationTools } from "./collaboration-tools.ts";
import { createChildSessionManager, ROOT, TeamManager } from "./team-manager.ts";

export { createChildSessionManager, TeamManager };

/** Collaboration guidance appended to the root agent prompt. */
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

/** Registers Multi-Agent V2 tools and lifecycle hooks. */
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
