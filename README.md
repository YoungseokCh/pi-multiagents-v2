# pi-multiagents-v2

A Pi extension implementing the core behavior of Codex Multi-Agent V2 with in-process `AgentSession` instances.

No markdown-backed agents are needed or configured by default.

## Features

- Hierarchical task paths (`/root/research/api`)
- Recursive subagent spawning
- Independent context windows with `fork_turns: "none" | "all" | "N"`
- Shared working directory and filesystem
- Asynchronous agent mailboxes and automatic final-answer delivery
- Persistent child context for follow-up tasks
- Configurable child-run concurrency (`PI_MULTIAGENTS_MAX_CONCURRENCY`, default `8`)
- Inherited model, reasoning level, active tools, extensions, skills, and context files

## Tools

- `spawn_agent`
- `send_message`
- `followup_task`
- `wait_agent`
- `list_agents`
- `interrupt_agent`

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

## Notes

Agents share a filesystem, so delegated coding tasks should use disjoint write scopes.

This is a behavioral port inspired by OpenAI Codex Multi-Agent V2, with these differences:

- Uses Pi `AgentSession` instances instead of Codex's Rust `ThreadManager`
- Copies messages for context forks instead of forking native Codex rollouts
- Does not restore the agent tree after reload, session replacement, or process restart
- Approximates Codex's scheduling, prompts, schemas, and edge-case behavior

## References

- https://github.com/openai/codex/blob/main/codex-rs/core/src/session/multi_agents.rs
- https://github.com/openai/codex/tree/main/codex-rs/core/src/tools/handlers/multi_agents_v2
