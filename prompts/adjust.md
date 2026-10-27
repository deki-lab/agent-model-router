The agent-model-router plugin has a config for this project at `.claude/agent-model-router.json`. It routes each subagent to a model, and runs a task one model higher when the same task is delegated again. Adjust that config to this project, then report. Keep it short.

## Read first

1. `.claude/agent-model-router.json`.
2. The agents this project can delegate to, with each one's name, `model` and description:
   - `.claude/agents/*.md`, the project's own;
   - agents installed for the user or by a plugin, as your own list of agent types shows them: user agents in `~/.claude/agents/*.md`, plugin agents named `<plugin>:<name>` (`dev-team:kody`), whose file is `agents/<name>.md` in the plugin's folder under `~/.claude/plugins/`.
3. The project's `CLAUDE.md` (and any file it points to for the workflow): how work is split into tasks, how tasks are named, where outcomes (reviews, verdicts, ledgers) are recorded.
4. Two or three of those task or outcome files, to see real task names.

## Change in the config

- `agents`: one entry per agent in `.claude/agents/`, plus `Explore`, plus each user or plugin agent that this project delegates to: `CLAUDE.md` or the workflow names it, or the journal shows it spawned. Leave out the others: a user's plugins serve many projects. Key a plugin agent by its full name (`dev-team:kody`). Add a missing agent on its frontmatter model; when that model is not on `ladder`, or its file cannot be read, add the entry without `model` so the agent keeps its own. Remove the entry of an agent that is no longer available. Keep the model and rules of an existing entry as they are: the user may have tuned them on purpose. Do not add models that are not on `ladder`, and do not change `ladder` or `maxModel`.
- If the config already fits the project, change nothing and say so. If the project delegates to no agent at all, change nothing and say that only built-in agents are routed.
- `escalation.taskKey`: a case-insensitive regular expression that matches the name of one task as this project writes it, in the project's language (`bloc\\s*\\d+|intro|outro`, `ticket\\s*#?\\d+`). The plugin uses the first match, searched in the delegation's `description`, then in its `prompt`. Leave it out when tasks have no stable names.
- `agents.<name>.rules`: add one only when the project clearly marks a kind of task as harder (an opening, a security change). Match a phrase that appears only in the request (`write the intro`), never a word that also appears in repeated context such as a list of finished tasks.
- `context`: globs of the files where outcomes are recorded.
- Regular expressions: JSON-escape backslashes. In JavaScript, `\b` only knows ASCII letters: never put `\b` next to an accented letter.

Write the file. Keep it valid JSON: the plugin reads it on every spawn, and a broken file turns routing off.

## Propose, do not apply

Retry detection works only if each delegation names its task in the `description` of the Agent call. Find the project's delegation rules in `CLAUDE.md` and propose one line to add there, in the project's language, for example:

> The `description` of each Agent call names the task and its scope, for example `Block 3 episode 2`.

Ask the user before editing `CLAUDE.md`.

## Report

Three to six lines: what changed in the config and why, the proposed `CLAUDE.md` line, and that `/model-router status` shows the active config.
