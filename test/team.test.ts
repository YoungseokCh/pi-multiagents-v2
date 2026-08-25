import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TeamManager } from "../extensions/index.ts";

test("root lifecycle and mailbox wake-up", async () => {
  const team = new TeamManager({} as ExtensionAPI);
  team.start({ cwd: "/tmp/project", isProjectTrusted: () => true } as ExtensionContext);

  assert.deepEqual(team.list("/root"), {
    agents: [{ agent_name: "/root", agent_status: { completed: null } }],
  });

  const waiting = team.wait("/root", 1_000, undefined);
  team.signalRootSteer();
  assert.deepEqual(await waiting, {
    message: "Wait interrupted by new input.",
    timed_out: false,
  });

  await team.dispose();
});
