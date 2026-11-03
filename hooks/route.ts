// Pure routing logic: config parsing and the model decision for one spawn.
// No `$` here, so every rule is testable on plain values.

export const CONFIG_PATH = '.claude/agent-model-router.json'
export const TUNER = 'model-tuner'

export type Rule = { match: string; model: string }

export type AgentEntry = { model?: string; rules: Rule[] }

/** At least `model` for a spawn whose description or prompt cites a path one of `paths` matches. */
export type Floor = { paths: string[]; model: string }

export type Config = {
  enabled: boolean
  ladder: string[]
  maxModel?: string
  agents: Record<string, AgentEntry>
  floors: Floor[]
  tags: boolean
  escalation: { enabled: boolean; taskKey?: string; windowMinutes: number }
  journal: { enabled: boolean; path: string; maxEntries: number }
  notify: boolean
  context: string[]
  /** What parsing changed and the user should know, such as a floor capped at `maxModel`. */
  warnings: string[]
}

export type Attempt = { model: string; count: number; at: number }

export type Source = 'tag' | 'caller' | 'rule' | 'table' | 'escalation' | 'floor' | 'default'

export type Choice = { model?: string; source: Source; detail?: string }

export type SpawnFacts = {
  agent: string
  prompt: string
  description: string
  given?: string
}

const TAG = /\[model:\s*([\w.\-]+)\s*\]/i

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, where: string): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${where} must be a non-empty string`)
  return v.trim()
}

const MAX_PATTERN = 300

/** Patterns are tested on at most this much text: a long prompt cannot stall a spawn. */
export const MAX_TESTED = 20_000

/**
 * True when a group that holds a repetition or an alternative is itself
 * repeated without bound (`(a+)+`, `(a|aa)*`, `(\d+){2,}`): the shapes whose
 * matching can backtrack for ever on a long prompt.
 */
const canBacktrack = (pattern: string): boolean => {
  const open: boolean[] = []
  let risky = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') { i++; continue }
    if (c === '[') {
      for (i++; i < pattern.length && pattern[i] !== ']'; i++) if (pattern[i] === '\\') i++
      continue
    }
    if (c === '(') { open.push(false); continue }
    if (c === '|' && open.length) open[open.length - 1] = true
    const unbounded = c === '+' || c === '*' || (c === '{' && /^\{\d+,\}/.test(pattern.slice(i)))
    if (c === ')') {
      const inner = open.pop() ?? false
      const next = pattern.slice(i + 1)
      if (inner && /^(?:[+*]|\{\d+,\})/.test(next)) risky = true
      if (inner && open.length) open[open.length - 1] = true
      continue
    }
    if (unbounded && open.length) open[open.length - 1] = true
  }
  return risky
}

const regex = (pattern: string, where: string): RegExp => {
  if (pattern.length > MAX_PATTERN) throw new Error(`${where} is longer than ${MAX_PATTERN} characters`)
  if (canBacktrack(pattern)) {
    throw new Error(`${where} repeats a group that itself repeats or has alternatives, which can backtrack for ever: ${pattern}`)
  }
  try {
    return new RegExp(pattern, 'i')
  } catch {
    throw new Error(`${where} is not a valid regular expression: ${pattern}`)
  }
}

export const JOURNAL_PATH = '.claude/agent-model-router/journal.jsonl'

/**
 * The config comes from the project, which may be an untrusted clone: the
 * journal is held to a relative path under `.claude/`, with no `..`, so the
 * plugin can never be pointed at a file outside the project.
 */
export const safeJournalPath = (value: unknown): string => {
  const path = str(value, 'journal.path').replace(/\\/g, '/')
  const parts = path.split('/')
  const isSafe = !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && parts[0] === '.claude' &&
    parts.length >= 2 && parts.every(p => p !== '' && p !== '.' && p !== '..')
  if (!isSafe) throw new Error(`journal.path must be a relative path under .claude/ with no "..": ${path}`)
  return path
}

/** Parses the project config, filling defaults. Throws a readable error on a bad field. */
export const parseConfig = (text: string): Config => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${(err as Error).message}`)
  }
  if (!isRecord(raw)) throw new Error(`${CONFIG_PATH} must hold a JSON object`)

  const ladder = raw.ladder === undefined
    ? ['haiku', 'sonnet', 'opus']
    : Array.isArray(raw.ladder) ? raw.ladder.map((m, i) => str(m, `ladder[${i}]`).toLowerCase()) : []
  if (ladder.length < 2) throw new Error('ladder must list at least two models, cheapest first')

  const agents: Record<string, AgentEntry> = {}
  const rawAgents = raw.agents ?? {}
  if (!isRecord(rawAgents)) throw new Error('agents must be an object keyed by agent name')
  for (const [name, value] of Object.entries(rawAgents)) {
    if (!isRecord(value)) throw new Error(`agents.${name} must be an object`)
    const rules = value.rules ?? []
    if (!Array.isArray(rules)) throw new Error(`agents.${name}.rules must be a list`)
    agents[name] = {
      model: value.model === undefined || value.model === null ? undefined : str(value.model, `agents.${name}.model`),
      rules: rules.map((r, i) => {
        const where = `agents.${name}.rules[${i}]`
        if (!isRecord(r)) throw new Error(`${where} must be { "match": ..., "model": ... }`)
        const match = str(r.match, `${where}.match`)
        regex(match, `${where}.match`)
        return { match, model: str(r.model, `${where}.model`) }
      }),
    }
  }

  const esc = isRecord(raw.escalation) ? raw.escalation : {}
  const taskKey = esc.taskKey === undefined ? undefined : str(esc.taskKey, 'escalation.taskKey')
  if (taskKey) regex(taskKey, 'escalation.taskKey')
  const jr = isRecord(raw.journal) ? raw.journal : {}
  const journalPath = jr.path === undefined ? JOURNAL_PATH : safeJournalPath(jr.path)
  const maxModel = raw.maxModel === undefined ? undefined : str(raw.maxModel, 'maxModel')
  if (maxModel && rankOf(maxModel, ladder) < 0) throw new Error(`maxModel must be on the ladder (${ladder.join(', ')}): ${maxModel}`)

  const warnings: string[] = []
  const rawFloors = raw.floors ?? []
  if (!Array.isArray(rawFloors)) throw new Error('floors must be a list of { "paths": [...], "model": ... }')
  const floors = rawFloors.map((f, i): Floor => {
    const where = `floors[${i}]`
    if (!isRecord(f) || !Array.isArray(f.paths) || f.paths.length === 0) throw new Error(`${where} must be { "paths": [...], "model": ... } with at least one path`)
    const paths = f.paths.map((g, j) => {
      const glob = str(g, `${where}.paths[${j}]`)
      if (glob.length > MAX_PATTERN) throw new Error(`${where}.paths[${j}] is longer than ${MAX_PATTERN} characters`)
      return glob
    })
    let model = str(f.model, `${where}.model`)
    if (rankOf(model, ladder) < 0) throw new Error(`${where}.model must be on the ladder (${ladder.join(', ')}): ${model}`)
    // The cap wins: nothing runs above maxModel, a floor included.
    if (maxModel && rankOf(model, ladder) > rankOf(maxModel, ladder)) {
      warnings.push(`floor ${model} on ${paths.join(', ')} capped at ${maxModel} (maxModel)`)
      model = maxModel
    }
    return { paths, model }
  })

  return {
    enabled: raw.enabled !== false,
    ladder,
    maxModel,
    agents,
    floors,
    tags: raw.tags !== false,
    escalation: {
      enabled: esc.enabled !== false,
      taskKey,
      windowMinutes: typeof esc.windowMinutes === 'number' && esc.windowMinutes > 0 ? esc.windowMinutes : 240,
    },
    journal: {
      enabled: jr.enabled !== false,
      path: journalPath,
      maxEntries: typeof jr.maxEntries === 'number' && jr.maxEntries > 0 ? Math.floor(jr.maxEntries) : 1000,
    },
    notify: raw.notify !== false,
    context: Array.isArray(raw.context) ? raw.context.filter((c): c is string => typeof c === 'string') : [],
    warnings,
  }
}

/**
 * A path glob as a regular expression on a whole path: `**` crosses
 * folders, `*` and `?` do not. Case-insensitive: a floor that matches too
 * often only costs money, one that misses can cost quality.
 */
export const globToRegExp = (glob: string): RegExp => {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ''
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out += '(?:[^/]*/)*'; i += 2 } else { out += '.*'; i += 1 }
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 'i')
}

const MAX_PATH = 300

/**
 * The paths a text cites: each word, stripped of quotes, brackets, a leading
 * `./`, a `:line:col` suffix and trailing punctuation.
 */
export const citedPaths = (text: string): string[] =>
  (text.match(/[^\s`'"()<>[\]{},;]+/g) ?? [])
    .map(w => w.replace(/^\.\//, '').replace(/(?::\d+){1,2}$/, '').replace(/[.:!?]+$/, ''))
    .filter(w => w !== '' && w.length <= MAX_PATH)

/** The highest floor a text reaches, with the glob that set it; undefined when none. */
export const floorFor = (text: string, cfg: Config): { model: string; glob: string } | undefined => {
  if (cfg.floors.length === 0) return undefined
  const paths = citedPaths(text)
  let best: { model: string; glob: string } | undefined
  for (const floor of cfg.floors) {
    if (best && rankOf(floor.model, cfg.ladder) <= rankOf(best.model, cfg.ladder)) continue
    const glob = floor.paths.find(g => {
      const re = globToRegExp(g)
      return paths.some(p => re.test(p))
    })
    if (glob) best = { model: floor.model, glob }
  }
  return best
}

/** Place of a model on the ladder: an alias (`sonnet`) or a full id that contains it. -1 when unknown. */
export const rankOf = (model: string | undefined, ladder: readonly string[]): number => {
  if (!model) return -1
  const m = model.toLowerCase()
  for (let i = ladder.length - 1; i >= 0; i--) {
    const step = ladder[i]
    if (step !== undefined && (m === step || m.includes(step))) return i
  }
  return -1
}

export const stepUp = (model: string, ladder: readonly string[]): string | undefined => {
  const r = rankOf(model, ladder)
  if (r < 0) return undefined
  return ladder[Math.min(r + 1, ladder.length - 1)]
}

/**
 * The config text with `model` added at the top of the ladder and made the
 * cap (`on`), or taken off both (`off`, the cap falling to the new top rung).
 * Every other field is kept as written. Throws when the result is not a valid config.
 */
export const withTopModel = (text: string, model: string, on: boolean): string => {
  parseConfig(text)
  const raw = JSON.parse(text) as Record<string, unknown>
  const ladder = Array.isArray(raw.ladder) ? raw.ladder.map(String) : ['haiku', 'sonnet', 'opus']
  const rest = ladder.filter(m => m.toLowerCase() !== model)
  raw.ladder = on ? [...rest, model] : rest
  if (on) raw.maxModel = model
  else if (typeof raw.maxModel === 'string' && raw.maxModel.toLowerCase() === model) raw.maxModel = rest[rest.length - 1]
  const out = `${JSON.stringify(raw, null, 2)}\n`
  parseConfig(out)
  return out
}

export type AgentFile = { name: string; model?: string }

/** Name and model from an agent file's frontmatter; the file name when it has no `name`. */
export const readAgentFile = (text: string, fileName: string): AgentFile => {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const field = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+?)["']?\\s*$`, 'm').exec(front)?.[1]
  return { name: field('name') ?? fileName.replace(/\.md$/, ''), model: field('model') }
}

/**
 * The config `/model-router init` writes: the project's own agents, each on
 * its frontmatter model when that model is on the default ladder. A model off
 * the ladder (`fable`, `inherit`) is left to the agent, so the table never
 * moves an agent to another model, and `maxModel` never caps it down.
 */
export const starterConfig = (agents: readonly AgentFile[]): object => {
  const ladder = ['haiku', 'sonnet', 'opus']
  const table: Record<string, { model?: string }> = { Explore: { model: 'haiku' } }
  for (const a of agents) {
    if (isTuner(a.name)) continue
    table[a.name] = a.model && rankOf(a.model, ladder) >= 0 ? { model: a.model } : {}
  }
  return {
    enabled: true,
    ladder,
    maxModel: 'opus',
    agents: table,
    floors: [],
    tags: true,
    escalation: { enabled: true, windowMinutes: 240 },
    journal: { enabled: true, path: JOURNAL_PATH, maxEntries: 1000 },
    notify: true,
    context: [],
  }
}

export const isTuner = (agent: string): boolean => agent === TUNER || agent.endsWith(`:${TUNER}`)

export const entryFor = (agent: string, cfg: Config): AgentEntry | undefined =>
  cfg.agents[agent] ?? cfg.agents[agent.split(':').pop() ?? agent] ?? cfg.agents['*']

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Identifies "the same task" across spawns: agent plus the taskKey match, else the description. */
export const taskKeyOf = (facts: SpawnFacts, cfg: Config): string => {
  let part = norm(facts.description)
  if (cfg.escalation.taskKey) {
    const m = regex(cfg.escalation.taskKey, 'escalation.taskKey').exec(`${facts.description}\n${facts.prompt}`.slice(0, MAX_TESTED))
    if (m) part = norm(m[1] ?? m[0])
  }
  return `${facts.agent}|${part}`
}

/** Drops attempts older than the window. */
export const prune = (raw: unknown, now: number, windowMinutes: number): Record<string, Attempt> => {
  const kept: Record<string, Attempt> = {}
  if (!isRecord(raw)) return kept
  const limit = now - windowMinutes * 60_000
  for (const [key, a] of Object.entries(raw)) {
    if (isRecord(a) && typeof a.model === 'string' && typeof a.count === 'number' && typeof a.at === 'number' && a.at >= limit) {
      kept[key] = { model: a.model, count: a.count, at: a.at }
    }
  }
  return kept
}

/**
 * The model for one spawn. Order: an explicit `[model: x]` tag in the prompt,
 * the caller's own `model`, the agent's first matching rule, the agent's table
 * model. A retry of the same task then steps one rung above what the previous
 * attempt ran on (never for a tag). A floor raises the result when the task
 * cites a sensitive path. `maxModel` caps everything.
 */
export const decide = (facts: SpawnFacts, cfg: Config, previous?: Attempt): Choice => {
  const text = `${facts.description}\n${facts.prompt}`.slice(0, MAX_TESTED)
  const entry = entryFor(facts.agent, cfg)
  let choice: Choice = { source: 'default' }

  const tag = cfg.tags ? TAG.exec(facts.prompt) : null
  if (tag?.[1]) {
    choice = { model: tag[1].toLowerCase(), source: 'tag' }
  } else if (facts.given) {
    choice = { model: facts.given, source: 'caller' }
  } else {
    const rule = entry?.rules.find(r => regex(r.match, 'rule').test(text))
    if (rule) choice = { model: rule.model, source: 'rule', detail: rule.match }
    else if (entry?.model) choice = { model: entry.model, source: 'table' }
  }

  if (choice.source !== 'tag' && previous && cfg.escalation.enabled) {
    const up = stepUp(previous.model, cfg.ladder)
    if (up && rankOf(up, cfg.ladder) > rankOf(choice.model, cfg.ladder)) {
      choice = { model: up, source: 'escalation', detail: `attempt ${previous.count + 1}, previous ${previous.model}` }
    }
  }

  // A floor raises whatever chose the model, a tag or the caller included. It
  // never lowers: when the agent's own model is unknown, it is left alone.
  const floor = floorFor(text, cfg)
  if (floor) {
    const have = rankOf(choice.model, cfg.ladder)
    if (choice.model === undefined) {
      choice = { ...choice, detail: [choice.detail, `floor ${floor.model} on ${floor.glob} not applied: the agent's own model is unknown`].filter(Boolean).join(', ') }
    } else if (have >= 0 && have < rankOf(floor.model, cfg.ladder)) {
      choice = { model: floor.model, source: 'floor', detail: `${floor.glob}, raised from ${choice.model} (${choice.source})` }
    }
  }

  // A model off the ladder (one the table does not know, such as `fable`
  // under the default ladder) cannot be ranked, so the cap replaces it too.
  if (choice.model && cfg.maxModel) {
    const rank = rankOf(choice.model, cfg.ladder)
    if (rank < 0 || rank > rankOf(cfg.maxModel, cfg.ladder)) {
      const why = rank < 0 ? `${choice.model} is not on the ladder, capped at ${cfg.maxModel}` : `capped at ${cfg.maxModel}`
      choice = { ...choice, model: cfg.maxModel, detail: [choice.detail, why].filter(Boolean).join(', ') }
    }
  }

  return choice
}
