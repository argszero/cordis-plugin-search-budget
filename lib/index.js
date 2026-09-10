/**
 * Cost budget for the model-facing `web_search` tool in the dsh harness.
 *
 * ## The gap this closes (discussion #6106)
 *
 * `web-search-deepseek` turns **every query string** into a full, separately
 * billable Messages request: `provider.ts` builds one request body per
 * `WebSearchRequest` (`Perform a web search for the query: <query>`) and calls
 * `recordRequest`, which appends one `web/deepseek-search-llm-request` session
 * event. The same request then carries a *server-side* search tool
 * (`web_search_20250305`, `max_uses: <maxUses>`), so one query can itself fan
 * out into up to `maxUses` native searches.
 *
 * Two different consumers each hold one factor of that product:
 *  - `tool-web.searchMaxQueries` (default **4**) bounds only the accepted
 *    `queries` array — a *per-call* bound; the model may call the tool any
 *    number of times;
 *  - `web-search-deepseek.maxUses` (default **5**) bounds only the searches
 *    inside *one* request.
 *
 * Neither is a total. `tool-web`'s own README states the hole explicitly: "no
 * native search counter covers the whole batch". A subagent whose prompt says
 * "search repeatedly with many different targeted queries" therefore walks past
 * both bounds, and with the subagent default `maxDepth: 3` a three-level
 * delegation tree issues requests at a rate no single knob governs. The #6106
 * report records 198 `web_search` **calls** producing 854 **billable
 * requests** in a three-turn session, ending in `402 Insufficient Balance`.
 *
 * The in-tree meter (`dsh-token-meter`) subscribes to `session/event` and
 * accounts only `assistant/message` usage, so none of those requests appear in
 * local cost reporting — the report's second finding.
 *
 * ## What this plugin does
 *
 * It is a `tools/pre-execute` gate. It estimates how many billable search
 * requests one `web_search` call would initiate — `distinctQueries ×
 * queriesPerRequest`, where `queriesPerRequest` defaults to the provider's
 * `maxUses` (5) — and denies the call (`{ kind: 'deny', reason }`) once any
 * configured budget would be exceeded.
 *
 * A denied call never reaches the provider, so a pre-execute estimate is the
 * only mechanism needed; no post-hoc accounting is required. Because the gate
 * only ever *rejects*, it can never cause a request that would not otherwise
 * occur.
 *
 * Four independent scopes are enforced, each optional (`0` disables it):
 *  - `perCall`    — requests a single call may initiate (default `10`);
 *  - `perTurn`    — requests one turn may initiate, across every agent;
 *  - `perSession` — requests one session may initiate;
 *  - `perTree`    — requests one top-level session and all of its subagent
 *    descendants may initiate together (default `60`). Lineage comes from the
 *    durable `SessionHeader.parentSession` chain resolved through
 *    `ctx.agents.get()`.
 *
 * The denial message is written for the model, not the operator: it names the
 * exhausted scope and the numbers involved, and says the ceiling is a
 * deployment setting — so the model reports the limit instead of "searching
 * harder".
 *
 * @module @argszero/cordis-plugin-search-budget
 */
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'search-budget';
/** The tool registry service whose `tools/pre-execute` waterfall this gates. */
export const inject = ['tools'];
export const Config = z.object({
    toolName: z.string().default('web_search'),
    queriesPerRequest: z.natural().default(5),
    perCall: z.natural().default(10),
    perTurn: z.natural().default(0),
    perSession: z.natural().default(0),
    perTree: z.natural().default(60),
    enforce: z.boolean().default(true),
});
/* -------------------------------------------------------------------------- */
/* Query estimation                                                           */
/* -------------------------------------------------------------------------- */
/**
 * Count the distinct, non-blank query strings one `web_search` call would send.
 *
 * Mirrors the in-tree estimator: `tool-web` accepts an array of non-blank
 * strings and collapses exact duplicates to first occurrence *before* provider
 * fan-out, so duplicates are counted once. Non-strings contribute nothing, and
 * an unparsable argument counts as `0` — this gate estimates and never guesses
 * upward, so a malformed call is left for the tool's own schema to reject.
 *
 * @param raw - the call's `arguments` (unvalidated model output).
 * @returns the number of distinct usable query strings.
 */
export function countQueries(raw) {
    if (typeof raw !== 'object' || raw === null)
        return 0;
    const queries = raw.queries;
    if (!Array.isArray(queries))
        return 0;
    const seen = new Set();
    for (const query of queries) {
        if (typeof query !== 'string')
            continue;
        const trimmed = query.trim();
        if (trimmed.length === 0)
            continue;
        seen.add(trimmed);
    }
    return seen.size;
}
/**
 * Resolve this agent's scope from its live session.
 *
 * @param agent - the executing agent.
 * @param lookup - resolves a live agent by session id (`ctx.agents.get`).
 * @returns the agent's session id, current turn, and top-level ancestor.
 */
export function resolveScope(agent, lookup) {
    const sessionId = agent.session.id;
    return {
        sessionId,
        turn: currentTurn(agent.session),
        rootId: resolveRootId(agent.session, sessionId, lookup),
    };
}
/**
 * Walk the durable `parentSession` chain to the top-level ancestor.
 *
 * Live lookup through `ctx.agents.get()` is preferred because the walk stops at
 * the first ancestor that is no longer live, and a dead ancestor's budget can
 * no longer grow — its id still names the tree, so it becomes the key.
 * `parentSession` is durable session metadata, so lineage is available even for
 * a child whose parent was persisted and only later re-entered.
 *
 * @param session - the agent's session (lineage source).
 * @param selfId - that session's own id (the chain's first step).
 * @param lookup - resolves a live agent by session id, if any.
 * @returns the top-level ancestor's session id (`selfId` when the chain is exhausted immediately).
 */
export function resolveRootId(session, selfId, lookup) {
    const seen = new Set([selfId]);
    let current = session;
    let currentId = selfId;
    for (;;) {
        const parentId = current.header.parentSession;
        if (parentId === undefined || seen.has(parentId))
            return currentId;
        seen.add(parentId);
        currentId = parentId;
        const parent = lookup(parentId);
        if (parent === undefined)
            return parentId;
        current = parent.session;
    }
}
/**
 * Read the turn number the session is currently inside.
 *
 * The turn number is not a session accessor — it lives in the `turn/start`
 * payload. The session caches its full-log snapshot until the next append, so
 * scanning it per tool call does not copy the log.
 *
 * @param session - the agent's session.
 * @returns the current turn number, or `0` when no turn has started (or the session exposes no snapshot).
 */
export function currentTurn(session) {
    if (session.snapshotEvents === undefined)
        return 0;
    const events = session.snapshotEvents(0, session.seq);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (typeof event !== 'object' || event === null)
            continue;
        const { type, data } = event;
        if (type !== 'turn/start')
            continue;
        const turn = data?.turn;
        if (typeof turn === 'number')
            return turn;
    }
    return 0;
}
/**
 * Tracks estimated spend against the configured budgets and answers admission
 * questions.
 *
 * State is per (plugin instance, scope key): turn counters reset when a turn
 * ends, session and tree counters are dropped when their session is disposed.
 * Nothing is persisted — a budget is a rate limit for the running deployment,
 * not a durable quota (durable accounting needs provider usage that the in-tree
 * meter does not currently record for these requests).
 */
export class SearchBudget {
    config;
    sessions = new Map();
    trees = new Map();
    turns = new Map();
    /**
     * @param config - resolved plugin configuration.
     */
    constructor(config) {
        this.config = config;
    }
    /** Estimated billable requests a call carrying `queries` distinct queries would initiate. */
    costOf(queries) {
        return queries * Math.max(1, this.config.queriesPerRequest);
    }
    /**
     * Test one call against every enabled budget, without spending.
     *
     * The budgets are checked cheapest-scope-first so the refusal names the
     * narrowest ceiling that is actually in the way.
     *
     * @param scope - the calling agent's resolved scope.
     * @param queries - distinct query strings the call would send.
     * @returns the admission outcome; `admitted` is true only when every enabled scope admits the call.
     */
    admit(scope, queries) {
        const cost = this.costOf(queries);
        const checks = [
            { scope: 'per-call', limit: this.config.perCall, bucket: undefined },
            {
                scope: 'per-turn',
                limit: this.config.perTurn,
                bucket: this.config.perTurn <= 0 ? undefined : this.turns.get(turnKey(scope)),
            },
            {
                scope: 'per-session',
                limit: this.config.perSession,
                bucket: this.config.perSession <= 0 ? undefined : this.sessions.get(scope.sessionId),
            },
            {
                scope: 'per-tree',
                limit: this.config.perTree,
                bucket: this.config.perTree <= 0 ? undefined : this.trees.get(scope.rootId),
            },
        ];
        for (const check of checks) {
            if (check.limit <= 0)
                continue;
            const spent = check.bucket?.spent ?? 0;
            if (spent + cost > check.limit) {
                return { admitted: false, cost, refusal: { scope: check.scope, limit: check.limit, spent } };
            }
        }
        return { admitted: true, cost };
    }
    /**
     * Charge an admitted call to every enabled scope.
     *
     * @param scope - the calling agent's resolved scope.
     * @param queries - distinct query strings the call sent.
     * @returns the charged cost.
     */
    charge(scope, queries) {
        const cost = this.costOf(queries);
        if (this.config.perTurn > 0)
            bucketFor(this.turns, turnKey(scope)).spent += cost;
        if (this.config.perSession > 0)
            bucketFor(this.sessions, scope.sessionId).spent += cost;
        if (this.config.perTree > 0)
            bucketFor(this.trees, scope.rootId).spent += cost;
        return cost;
    }
    /**
     * Drop the state belonging to one disposed session.
     *
     * Whole-tree counters are keyed by the top-level ancestor, so a disposed
     * *child* leaves the tree counter alone — only the tree root's disposal
     * clears it.
     *
     * @param sessionId - the session that is no longer live.
     */
    release(sessionId) {
        for (const key of [...this.turns.keys()]) {
            if (key.startsWith(`${sessionId}\u0000`))
                this.turns.delete(key);
        }
        this.sessions.delete(sessionId);
        this.trees.delete(sessionId);
    }
    /** Test-only view of the spend charged to one scope. */
    spendOf(kind, key) {
        const map = kind === 'turn' ? this.turns : kind === 'session' ? this.sessions : this.trees;
        return map.get(key)?.spent ?? 0;
    }
}
/** Turn counters are per session, so two sessions never share one. */
function turnKey(scope) {
    return `${scope.sessionId}\u0000${scope.turn}`;
}
/** Read or create one scope's counter. */
function bucketFor(map, key) {
    let bucket = map.get(key);
    if (bucket === undefined) {
        bucket = { spent: 0 };
        map.set(key, bucket);
    }
    return bucket;
}
/* -------------------------------------------------------------------------- */
/* Denial text                                                                */
/* -------------------------------------------------------------------------- */
/** Stable failure prefix so a deployment can grep its own traces. */
export const DENIAL_PREFIX = 'web_search cost budget exhausted';
/**
 * Build the model-facing refusal for one exceeded scope.
 *
 * The text names the scope, the numbers, and the fact that the ceiling is a
 * deployment setting — the model must report the limit, not retry with fewer
 * queries (retrying is what turns one over-budget call into a runaway loop).
 *
 * @param refusal - the scope that refused the call and its numbers.
 * @param cost - the estimated requests this call would have initiated.
 * @returns the denial reason.
 */
export function denialReason(refusal, cost) {
    return `${DENIAL_PREFIX} (${refusal.scope}): this call would issue an estimated ${cost} billable search `
        + `request(s) (distinct queries x per-request native searches), but the ${refusal.scope} budget is `
        + `${refusal.limit} and ${refusal.spent} request(s) have already been spent. Do not retry with the same `
        + `or more queries. Reuse the search results already in this conversation, narrow the question, or report `
        + `that the deployment's search budget is exhausted — raising the ceiling is a deployment configuration `
        + `change (search-budget plugin: perCall/perTurn/perSession/perTree), not something a tool call can do.`;
}
/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */
/**
 * The plugin's own resolved configuration, re-exported for callers that mount
 * it through the test seam rather than the loader.
 *
 * @param ctx - the plugin context.
 * @param config - the raw configuration section.
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const budget = new SearchBudget(resolved);
    // `SessionId` is a branded string; these ids come from a durable session
    // header, which the session boundary validates before it is ever exposed.
    const lookup = (id) => ctx.get('agents')?.get(id);
    ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.name !== resolved.toolName)
            return next();
        const agent = exec.agent;
        // Without an agent there is no session to scope against; the in-tree
        // pipeline guarantees one for a tool call the loop dispatched, so an
        // absent agent means this is not a model-directed call.
        if (agent === undefined)
            return next();
        const queries = countQueries(exec.arguments);
        if (queries === 0)
            return next();
        const scope = resolveScope(agent, lookup);
        const admission = budget.admit(scope, queries);
        if (!admission.admitted) {
            if (resolved.enforce) {
                const refusal = admission.refusal;
                return refusal === undefined
                    ? { kind: 'allow' }
                    : { kind: 'deny', reason: denialReason(refusal, admission.cost) };
            }
            ctx.logger?.warn(`${DENIAL_PREFIX} (${admission.refusal?.scope ?? 'unknown'}, observe-only): `
                + `estimated ${admission.cost} request(s) would have exceeded the budget`);
            return next();
        }
        budget.charge(scope, queries);
        return next();
    });
    // Session-scoped state must not outlive its session, or a long-lived daemon
    // would accumulate one counter per session it ever opened.
    ctx.on('session/disposed', (session) => {
        budget.release(sessionIdOf(session));
    });
}
/** Resolve the configuration section, filling every default. */
export function resolveConfig(config) {
    return {
        toolName: config.toolName ?? 'web_search',
        queriesPerRequest: config.queriesPerRequest ?? 5,
        perCall: config.perCall ?? 10,
        perTurn: config.perTurn ?? 0,
        perSession: config.perSession ?? 0,
        perTree: config.perTree ?? 60,
        enforce: config.enforce ?? true,
    };
}
/** Read a session id off a disposal payload without depending on its type. */
function sessionIdOf(session) {
    if (typeof session !== 'object' || session === null)
        return '';
    const id = session.id;
    return typeof id === 'string' ? id : '';
}
