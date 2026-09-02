# pi-multiagents-v2

A Pi extension implementing the core behavior of Codex Multi-Agent V2 with in-process `AgentSession` instances.

No markdown-backed agents are needed or configured by default.

## Install

```bash
pi install npm:pi-multiagents-v2
# or install directly from GitHub
pi install git:github.com/YoungseokCh/pi-multiagents-v2
```

Or test without installing:

```bash
pi -e git:github.com/YoungseokCh/pi-multiagents-v2
```

## Features

- Hierarchical task paths (`/root/research/api`)
- Recursive subagent spawning
- Independent context windows with `fork_turns: "none" | "all" | "N"`
- Asynchronous agent mailboxes and automatic final-answer delivery
- Persistent child context for follow-up tasks
- Configurable child-run concurrency (`PI_MULTIAGENTS_MAX_CONCURRENCY`, default `8`)

## Tools

These tools are used by master agent to orchestrate multiagents-v2. (not exposed to user)

- `spawn_agent`: Starts a child agent for an independent subtask.
  - task_name: string
  - message: string
  - fork_turns: "none" | "all" (default) | "N"
  - reasoning_effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
- `send_message`: Sends information without waking an idle agent.
  - target: string
  - message: string
- `followup_task`: Assigns more work and starts or redirects an agent.
  - target: string
  - message: string
- `wait_agent`: Waits for agent messages, user input, or timeout.
  - timeout_ms: int
- `list_agents`: Lists agents and their current statuses.
  - path_prefix: string
- `interrupt_agent`: Stops an agent's current turn while preserving its context.
  - target: string

## Changelog

### v0.1.2

- Persist named child sessions under persisted parents, linked through `parentSession` for native `/resume` and `/tree` inspection.
- Keep child sessions in-memory when the parent session is ephemeral.
- Hide inter-agent mailbox envelopes from the root transcript while retaining them in model context.
- Await final-answer delivery before releasing a child run.
- Match Codex's TUI behavior by hiding `list_agents` and rendering `wait_agent` as waiting/finished lifecycle status.

Child-session navigation is intended after the team finishes because switching sessions shuts down an active team.

## References

- https://github.com/openai/codex/blob/main/codex-rs/core/src/session/multi_agents.rs
- https://github.com/openai/codex/tree/main/codex-rs/core/src/tools/handlers/multi_agents_v2
