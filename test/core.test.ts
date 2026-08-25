import assert from "node:assert/strict";
import test from "node:test";
import {
  childPath,
  formatEnvelope,
  parseForkTurns,
  removeIncompleteTail,
  resolveTarget,
  selectForkMessages,
} from "../extensions/core.ts";

test("canonical paths and references", () => {
  assert.equal(childPath("/root/research", "api_2"), "/root/research/api_2");
  assert.equal(resolveTarget("/root", "research"), "/root/research");
  assert.equal(resolveTarget("/root/research", "/root/worker"), "/root/worker");
  assert.throws(() => childPath("/root", "Bad-Name"));
});

test("fork selection drops the unresolved spawning turn", () => {
  const messages = [
    { role: "user", content: "one" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "two" },
    { role: "assistant", content: [{ type: "toolCall", id: "spawn", name: "spawn_agent" }] },
  ];
  assert.deepEqual(removeIncompleteTail(messages), messages.slice(0, 3));
  assert.deepEqual(selectForkMessages(messages, "1"), messages.slice(2, 3));
  assert.deepEqual(selectForkMessages(messages, "none"), []);
  assert.equal(parseForkTurns(undefined), "all");
  assert.throws(() => parseForkTurns("0"));
});

test("mail envelope matches the V2 context format", () => {
  assert.equal(
    formatEnvelope("MESSAGE", "/root/worker", "/root", "Check API"),
    "Message Type: MESSAGE\nTask name: /root/worker\nSender: /root\nPayload:\nCheck API",
  );
});
