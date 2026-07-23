# pi-subagents

A [pi](https://github.com/earendil-works/pi) extension that adds subagent orchestration tools — delegate tasks to specialized agents with isolated context windows.

Each subagent invocation spawns a separate `pi` process, giving it a clean context window independent of the parent conversation.

## Install

```bash
# Global (user-level)
pi install ssh://git@github.com/AshesToAgents/pi-subagents.git

# Project-level (shared with team via .pi/settings.json)
pi install -l ssh://git@github.com/AshesToAgents/pi-subagents.git

# Try without installing
pi -e ssh://git@github.com/AshesToAgents/pi-subagents.git
```

## What's Included

| Type | Name | Description |
|------|------|-------------|
| Tool | `subagent` | Delegate tasks to specialized agents (single, parallel, or chain mode) |
| Tool | `subagent_agents` | List available subagents with name, description, source, model, and tools |
| Command | `/subagents` | List available subagents with optional scope and detail filters |
| Command | `/subagent-models` | Configure `fastModel`/`smartModel` aliases used by subagents |
| Command | `/subagent-tmux` | Toggle automatic tmux window opening for subagent sessions |
| Command | `/subagent-resume` | Resume a subagent session in a new tmux window |

On startup, pi-subagents injects an agent overview into the system prompt so the model knows which subagents are available without making an extra tool call.

## Usage

### Modes

#### Single — one agent, one task

```
subagent({ agent: "implementer", task: "Add error handling to the login function" })
```

#### Parallel — multiple agents, concurrent execution

Up to 8 tasks, with a concurrency limit of 4. Each agent gets its own process and context.

```
subagent({
  tasks: [
    { agent: "scout", task: "Find all files using the deprecated API" },
    { agent: "scout", task: "Map the database schema relationships" },
  ]
})
```

#### Chain — sequential steps, output piped forward

Each step receives the previous step's output via the `{previous}` placeholder. Stops on first error.

```
subagent({
  chain: [
    { agent: "scout", task: "Analyze the codebase structure" },
    { agent: "implementer", task: "Based on: {previous}\n\nImplement the refactoring" },
    { agent: "scout", task: "Review these changes for issues: {previous}" },
  ]
})
```

#### Continue — multi-turn follow-ups

Every subagent invocation returns a `subagentIndex` (a session counter). Use `continue` with that index to send a follow-up message to the same session — the subagent retains its full context from previous turns.

```
// First call — returns subagentIndex: 1
subagent({ agent: "scout", task: "Analyze the auth module" })

// Follow-up — continues session 1 with full context
subagent({ agent: "scout", task: "Tell me more about the token refresh flow", continue: 1 })
```

Works in all modes:

```
// Parallel follow-ups to different sessions
subagent({
  tasks: [
    { agent: "scout", task: "Elaborate on the auth flow", continue: 1 },
    { agent: "scout", task: "Elaborate on the DB schema", continue: 2 },
  ]
})
```

### Scope Filtering

Both tools accept an `agentScope` parameter to control which agent sources are searched:

| Scope | Agents included |
|-------|----------------|
| `all` (default) | User + project + package |
| `user` | `~/.pi/agent/agents/` only |
| `project` | `.pi/agents/` only |
| `package` | Agents from installed pi packages only |

### Configuration

Configure model aliases with `/subagent-models` or edit `~/.pi/agent/settings.json`:

```json
{
  "fastModel": "anthropic/claude-sonnet-4-20250514",
  "smartModel": "anthropic/claude-opus-4-20250122"
}
```

### Session Persistence

By default, subagent sessions are now persisted alongside the parent session in a `subagents/` subdirectory. Each subagent gets a session ID of `<parentId>-<counter>` (e.g., `a1b2c3d4-1`, `a1b2c3d4-2`), where the counter increments globally across the parent session.

Sessions are stored in `<parentSessionDir>/subagents/` and can be resumed at any time.

### Tmux Integration

When running inside a tmux session, pi-subagents can automatically open a new tmux window for each completed subagent, giving you the full interactive pi TUI experience to inspect and continue the conversation.

**Enable with `/subagent-tmux`:**

```
/subagent-tmux          # Toggle between "always" and "never"
```

Or set directly in `~/.pi/agent/settings.json`:

```json
{
  "subagentTmux": "always"
}
```

When enabled, a new tmux window named `pi: <agentName>` opens after each successful subagent invocation.

**Resume sessions on demand with `/subagent-resume`:**

```
/subagent-resume        # List subagent sessions and pick one
/subagent-resume 2      # Open subagent session #2 directly
```

This works regardless of the `subagentTmux` setting — you can keep auto-opening disabled and manually resume sessions when needed.

## Defining Agents

Agents are Markdown files with YAML frontmatter, discovered from three sources:

| Scope | Directory | Description |
|-------|-----------|-------------|
| **User** | `~/.pi/agent/agents/` | Personal agents available everywhere |
| **Project** | `.pi/agents/` | Repo-specific agents, shared with the team |
| **Package** | `agents/` in installed packages | Agents bundled with pi packages |

### Agent file format

```markdown
---
name: implementer
description: Fast code change agent for well-defined modifications
tools: read, bash, edit, write, grep, find, ls
model: fast
---

You are a focused code editor. Implement the requested changes precisely
and concisely. Do not add unnecessary commentary or explanation.
```

**Frontmatter fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Agent identifier used in tool calls |
| `description` | Yes | Short summary shown in listings |
| `tools` | No | Comma-separated allowlist of tools the agent can use |
| `model` | No | Model selection (see below) |

### Model resolution

The `model` field supports several formats:

| Value | Resolution |
|-------|-----------|
| *(empty/omit)* | Use pi's default model |
| `parent` | Same model as the parent agent |
| `fast` | Alias from `fastModel` in settings (falls back to parent) |
| `smart` | Alias from `smartModel` in settings (falls back to parent) |
| `provider/model-id` | Direct model reference |
| `model-id` | Bare ID, prefixed with current provider |

## Tool Policy

Agent definitions can restrict which tools the subagent process has access to via the `tools` frontmatter field. Built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) are passed through `--tools`, and extension tools are controlled via the `--extension-tools` flag.

If `tools` is omitted, the subagent gets all default tools.

## Security

When `confirmProjectAgents` is `true` (the default), pi-subagents prompts before running project-local agents — since those are controlled by the repository and may not be trusted. This can be disabled per-invocation:

```
subagent({ agent: "my-agent", task: "...", confirmProjectAgents: false })
```

Extension tools in child processes are blocked by default unless explicitly allowed via the `--extension-tools` flag.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
