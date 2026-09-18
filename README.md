# @argszero/cordis-plugin-search-budget

A **cost budget for `web_search`** in the [dsh harness](https://github.com/deepseek-ai/deepseek-harness).
It caps the number of **billable provider search requests** a `web_search` call may
initiate — per call, per turn, per session, and per whole subagent tree — and
**denies** the call with an actionable message once a budget is exhausted.

## Why

`web-search-deepseek` turns **every query string** into a full, separately billable
Messages request. `packages/web/web-search-deepseek/src/provider.ts` builds one
request body per search (`Perform a web search for the query: <query>`) and reports
it through `recordRequest`, which appends one `web/deepseek-search-llm-request`
session event per query. That same request then carries a *server-side* search tool
(`web_search_20250305`, `max_uses: <maxUses>`), so one query can itself fan out into
up to `maxUses` native searches.

Two different consumers each hold one factor of the resulting product:

| Knob | Default | What it actually bounds |
|---|---|---|
| `tool-web.searchMaxQueries` | `4` | the accepted `queries` **array of one call** — the model may call the tool any number of times |
| `web-search-deepseek.maxUses` | `5` | server-side searches **inside one request** |

Neither is a total. `tool-web`'s own README states the hole out loud:

> **No native search counter covers the whole batch** — `searchMaxQueries` limits
> `ctx.web.search` calls, but a provider can perform several native searches inside
> each call.

So a subagent whose prompt says *"use the `web_search` tool repeatedly with many
different targeted queries"* walks past both bounds, and with the subagent default
`maxDepth: 3` a three-level delegation tree issues requests at a rate no single knob
governs. Discussion **#6106** records the outcome on a **three-turn** session:
**198** `web_search` calls → **854** billable requests inside ~5 minutes (~246 in any
60-second window), ending in `402 Insufficient Balance`.

The same report notes a second gap this plugin does not close but leaves visible:
`dsh-token-meter` subscribes to `session/event` and accounts only `assistant/message`
usage, so those 668 search requests never appear in local cost reporting.

## What it does

It registers a [`tools/pre-execute`](https://deepseek-ai.github.io/deepseek-harness/)
listener — the same pre-dispatch waterfall the in-tree `guard/timeout-policy` uses.
For each `web_search` call it estimates the billable requests the call would
initiate:

```
cost = distinct(queries) × queriesPerRequest     # queriesPerRequest defaults to the provider's maxUses (5)
```

and charges that estimate to every enabled scope. The first scope that would be
exceeded **denies** the call (`{ kind: 'deny', reason }`) — the provider is never
reached, so no request is issued and no charge is incurred.

Because the gate only ever *rejects*, it can never cause a request that would not
otherwise have happened, and because it decides **before** dispatch it needs no
post-hoc accounting. The estimate is the whole mechanism.

### Scopes (all optional; `0` disables a scope)

| Config | Default | Meaning |
|---|---|---|
| `perCall` | `10` | requests a single `web_search` call may initiate |
| `perTurn` | `0` (off) | requests one turn may initiate, across every agent |
| `perSession` | `0` (off) | requests one session may initiate |
| `perTree` | `60` | requests one session **and all of its subagent descendants** may initiate together |

`perTree` is the one no in-tree knob provides. Lineage is read from the durable
`SessionHeader.parentSession` chain and resolved through `ctx.agents.get()`, so a
child's spend is charged to the top-level ancestor that spawned it. The walk stops
at the first ancestor that is no longer live; a dead ancestor's budget can no longer
grow, but its id still names the tree.

## Install / mount

```sh
npm install @argszero/cordis-plugin-search-budget
```

The bundle patch mounts the plugin with its defaults:

```yaml
# inside the package's cordis.patch.yml — already applied by `dsh` bundle install
- insert:
    - id: search-budget
      name: '@argszero/cordis-plugin-search-budget'
```

### Tuning

```yaml
# a profile layer / overlay
- set:
    - id: search-budget
      config:
        queriesPerRequest: 5   # provider maxUses: native searches per query
        perCall: 10            # requests one call may initiate
        perTurn: 0             # 0 = off
        perSession: 0          # 0 = off
        perTree: 60            # a session + all its subagents together
        enforce: true          # false = observe-only (logs the would-be denial, never denies)
```

* Set `queriesPerRequest: 1` for a provider that issues exactly one request per query
  (e.g. a plain search API, or `web-search-exa`/`web-search-perplexity` semantics).
* `enforce: false` is the recommended first step on an existing deployment: run it for
  a day to see what your real workload costs, then set budgets from the log.
* `toolName` (default `web_search`) retargets the gate if a deployment registers the
  tool under another name.

## What it deliberately does not do

* **It does not account for actual provider usage.** The estimate bounds admission;
  an exact total would need per-request usage that the search-LLM-request path does
  not currently record. Do not treat the estimate as a billing figure.
* **It does not touch `searchMaxQueries` or `maxUses`.** Those still apply, and they
  still bound one call and one request respectively. This plugin adds the total that
  was missing; it does not replace the per-call knobs.
* **It does not fix the local usage meter.** Making `web/deepseek-search-llm-request`
  visible to cost reporting is an in-tree change to the token meter.
* **It does not persist state.** Budgets are a running-deployment rate limit, not a
  durable quota across restarts. On a restart the counter is fresh.

## Compatibility

Built and typechecked against dsh `0.1.5-rc.1` / `@deepseek-ai/cordis` `4.0.2`. The
harness packages are **type-only** imports, so the plugin has no runtime dependency
on them — it declares only `cordis` as a peer, and no dsh version range at all, so
there is nothing for npm to refuse on a different line.

**0.1.1 fixed a packaging defect that made the artifact unloadable outside the
author's tree.** `src/index.ts` imports `@deepseek-ai/schemastery` for value, but
0.1.0 declared no `dependencies` block: the library resolved only because this
repo's own `node_modules` had it hoisted off a sibling devDependency. A consumer
installing into a tree that does not happen to provide it got, at mount time:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
imported from .../node_modules/@argszero/cordis-plugin-search-budget/lib/index.js
```

`schemastery` is now a declared dependency, and `test/packaging.test.js` fails if
any value import in the source is missing from `dependencies`/`peerDependencies` —
a dependency that only resolves in the author's tree is not a declared one.

## Tests

```sh
npm test     # tsc + node --test test/*.test.js   (35 tests)
```

The suite covers query estimation (including the exact-duplicate collapsing and the
blank/non-string handling that `tool-web` itself performs), lineage resolution
(including a cyclic-lineage guard and a dead-ancestor stop), turn detection, the
cost model, admission and charging per scope, release-on-dispose, the denial text,
a replay of the #6106 fan-out shape against the shipped defaults, and the
packaging contract (every runtime import is declared in the manifest).

## License

MIT
