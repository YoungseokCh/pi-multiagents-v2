import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChildSessionManager, TeamManager } from "../extensions/index.ts";

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

test("child sessions follow parent persistence", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-multiagents-v2-"));
  try {
    const parent = SessionManager.create("/tmp/project", sessionDir);
    const child = createChildSessionManager("/tmp/project", parent, "/root/worker");

    assert.equal(child.isPersisted(), true);
    assert.equal(child.getHeader()?.parentSession, parent.getSessionFile());
    assert.equal(child.getSessionDir(), sessionDir);
    assert.equal(child.getSessionName(), "/root/worker");
    child.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const [listedChild] = await SessionManager.list("/tmp/project", sessionDir);
    assert.equal(listedChild.name, "/root/worker");
    assert.equal(listedChild.parentSessionPath, parent.getSessionFile());

    const ephemeral = createChildSessionManager(
      "/tmp/project",
      SessionManager.inMemory("/tmp/project"),
      "/root/scout",
    );
    assert.equal(ephemeral.isPersisted(), false);
    assert.equal(ephemeral.getHeader()?.parentSession, undefined);
    assert.equal(ephemeral.getSessionName(), "/root/scout");
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("root mailbox stays model-visible but hidden from the transcript", async () => {
  const sent: Array<{ message: { content: unknown; display: boolean }; options: unknown }> = [];
  const pi = {
    sendMessage(message: { content: unknown; display: boolean }, options: unknown) {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const team = new TeamManager(pi);
  team.start({ cwd: "/tmp/project", isProjectTrusted: () => true } as ExtensionContext);

  await team.sendMessage("/root/worker", "/root", "done");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.display, false);
  assert.match(String(sent[0].message.content), /Sender: \/root\/worker/);
  await team.dispose();
});
