import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createCollaborationTools } from "../extensions/collaboration-tools.ts";
import type { TeamManager } from "../extensions/team-manager.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

const context = (isError = false) => ({ isError }) as any;
const render = (component: { render(width: number): string[] }) => component.render(80).map((line) => line.trimEnd());

test("Codex-style list and wait rendering", () => {
  const tools = createCollaborationTools({} as TeamManager, "/root");
  const list = tools.find((tool) => tool.name === "list_agents")!;
  const wait = tools.find((tool) => tool.name === "wait_agent")!;

  assert.equal(list.renderShell, "self");
  assert.deepEqual(render(list.renderCall!({}, theme, context())), []);
  assert.deepEqual(
    render(list.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, context())),
    [],
  );

  assert.equal(wait.renderShell, "self");
  assert.deepEqual(render(wait.renderCall!({}, theme, context())), ["• Waiting for agents"]);
  assert.deepEqual(
    render(wait.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, context())),
    ["", "• Finished waiting"],
  );
  assert.deepEqual(
    render(wait.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, context(true))),
    ["", "• Wait failed"],
  );
});
