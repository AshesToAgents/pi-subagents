# pi-subagent

A [pi](https://github.com/MarioZechner/pi-coding-agent) package that adds subagent orchestration tools — delegate tasks to specialized agents with isolated context windows.

Each subagent invocation spawns a separate `pi` process, giving it a clean context window independent of the parent conversation.

## Installation

```bash
# Global (user-level)
pi install git:github.com/phoenixlab/pi-subagent

# Project-level (shared with team via .pi/settings.json)
pi install -l git:github.com/phoenixlab/pi-subagent

# Try without installing
pi -e git:github.com/phoenixlab/pi-subagent
```

## What It Adds

### Tools

| Tool | Description |
|------|-------------|
| `subagent` | Delegate tasks to specialized agents. Supports single, parallel, and chain modes. |
| `subagent_agents` | List available subagents with name, description, source, model, and tools. |

### Commands

| Command | Description |
|---------|-------------|
| `/subagents` | List available subagents with optional scope and detail filters. |
| `/subagent-models` | Configure `fastModel`/`smartModel` aliases used by subagents. |

### System Prompt

On startup, pi-subagent injects an agent overview into the system prompt so the model knows which subagents are available without making an extra tool call.

## Modes

### Single — one agent, one task

```
subagent({ agent: "implementer", task: "Add error handling to the login function" })
```

### Parallel — multiple agents, concurrent execution

Up to 8 tasks, with a concurrency limit of 4. Each agent gets its own process and context.

```
subagent({
  tasks: [
    { agent: "scout", task: "Find all files using the deprecated API" },
    { agent: "scout", task: "Map the database schema relationships" },
  ]
})
```

### Chain — sequential steps, output piped forward

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

- `name` (required) — agent identifier used in tool calls
- `description` (required) — short summary shown in listings
- `tools` (optional) — comma-separated allowlist of tools the agent can use
- `model` (optional) — model selection (see below)

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

Configure aliases with `/subagent-models` or edit `~/.pi/agent/settings.json`:

```json
{
  "fastModel": "anthropic/claude-sonnet-4-20250514",
  "smartModel": "anthropic/claude-opus-4-20250122"
}
```

## Tool Policy

Agent definitions can restrict which tools the subagent process has access to via the `tools` frontmatter field. Built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) are passed through `--tools`, and extension tools are controlled via the `--extension-tools` flag.

If `tools` is omitted, the subagent gets all default tools.

## Security

When `confirmProjectAgents` is `true` (the default), pi-subagent prompts before running project-local agents — since those are controlled by the repository and may not be trusted. This can be disabled per-invocation:

```
subagent({ agent: "my-agent", task: "...", confirmProjectAgents: false })
```

Extension tools in child processes are blocked by default unless explicitly allowed via the `extension-tools` flag.

## Scope Filtering

Both tools accept an `agentScope` parameter to control which agent sources are searched:

| Scope | Agents included |
|-------|----------------|
| `all` (default) | User + project + package |
| `user` | `~/.pi/agent/agents/` only |
| `project` | `.pi/agents/` only |
| `package` | Agents from installed pi packages only |

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

Private
