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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "search-budget";
/** The tool registry service whose `tools/pre-execute` waterfall this gates. */
export declare const inject: string[];
/** Plugin configuration. Every budget is in ESTIMATED BILLABLE REQUESTS. */
export interface Config {
    /**
     * The model-facing search tool to meter. Default `'web_search'`. Change it
     * only for a deployment that registers the tool under another name.
     */
    toolName?: string;
    /**
     * Estimated billable requests produced by ONE query string. One query is one
     * complete Messages request, so this is `1` per native search the provider may
     * run inside it — i.e. the provider's `maxUses` (dsh-web-search-deepseek
     * default 5). Set `1` for a provider that issues exactly one search per query.
     */
    queriesPerRequest?: number;
    /** Requests a single `web_search` call may initiate. `0` disables. Default `10`. */
    perCall?: number;
    /** Requests one turn may initiate, across every agent. `0` disables. Default `0`. */
    perTurn?: number;
    /** Requests one session may initiate. `0` disables. Default `0`. */
    perSession?: number;
    /**
     * Requests one top-level session and all of its subagent descendants may
     * initiate together. `0` disables. Default `60`.
     */
    perTree?: number;
    /**
     * When `true` (default), an exhausted budget denies the call. When `false`
     * the plugin observes only (it never denies) — useful for measuring a real
     * workload before committing to a budget.
     */
    enforce?: boolean;
}
/** Resolved config: every field carries its validated default. */
export type ResolvedConfig = Required<Config>;
export declare const Config: z<Config>;
/** The scoped `Session` view this plugin needs (lineage + current turn). */
export interface SessionLike {
    /** This session's id — the key its own budgets are stored under. */
    readonly id: string;
    /** Durable header; only fork lineage is read. */
    readonly header: {
        readonly parentSession?: string;
    };
    /** Half-open log end (`session.seq`); only its size is used. */
    readonly seq: number;
    /**
     * Immutable snapshot of a log range. Optional so a minimal test double can
     * omit it; a session without it is treated as turn `0`.
     *
     * Declared in method syntax and with a wide element type on purpose: the real
     * signature takes branded `SessionLogOffset` parameters and returns a
     * discriminated union of ~40 event shapes. Method syntax keeps the check
     * bivariant (so the branded signature is assignable here) and `currentTurn`
     * narrows the one field it needs at runtime.
     */
    snapshotEvents?(from?: number, toExclusive?: number): readonly unknown[];
}
/** The scoped `Agent` view this plugin needs (lineage + turn source). */
export interface AgentLike {
    readonly session: SessionLike;
}
/** The registry-assigned execution view handed to `tools/pre-execute`. */
export interface ToolExecutionLike {
    readonly name: string;
    readonly arguments: unknown;
    readonly agent?: AgentLike;
}
/** Pre-dispatch decision (the harness' `PreToolDecision`). */
export type PreToolDecision = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
} | {
    kind: 'ask';
    reason?: string;
};
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
export declare function countQueries(raw: unknown): number;
/** One resolved agent: its session, its current turn, and its top-level ancestor. */
export interface AgentScope {
    /** The agent/session id. */
    readonly sessionId: string;
    /** The current turn number (`0` before the first `turn/start`). */
    readonly turn: number;
    /** The id of this agent's top-level ancestor — the whole-tree budget key. */
    readonly rootId: string;
}
/** Reads a live agent by session id, when one is registered. */
export type AgentLookup = (id: string) => AgentLike | undefined;
/**
 * Resolve this agent's scope from its live session.
 *
 * @param agent - the executing agent.
 * @param lookup - resolves a live agent by session id (`ctx.agents.get`).
 * @returns the agent's session id, current turn, and top-level ancestor.
 */
export declare function resolveScope(agent: AgentLike, lookup: AgentLookup): AgentScope;
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
export declare function resolveRootId(session: SessionLike, selfId: string, lookup: AgentLookup): string;
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
export declare function currentTurn(session: SessionLike): number;
/** A scope that refused a call, with the numbers that explain why. */
export interface Refusal {
    /** Stable scope name: `per-call` | `per-turn` | `per-session` | `per-tree`. */
    readonly scope: string;
    /** The scope's ceiling. */
    readonly limit: number;
    /** Spend already charged to the scope. */
    readonly spent: number;
}
/** Outcome of one admission attempt. */
export interface Admission {
    /** `true` when the call fits every enabled budget. */
    readonly admitted: boolean;
    /** Estimated billable requests the call would initiate. */
    readonly cost: number;
    /** The scope that refused the call, when `admitted` is false. */
    readonly refusal?: Refusal;
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
export declare class SearchBudget {
    private readonly config;
    private readonly sessions;
    private readonly trees;
    private readonly turns;
    /**
     * @param config - resolved plugin configuration.
     */
    constructor(config: ResolvedConfig);
    /** Estimated billable requests a call carrying `queries` distinct queries would initiate. */
    costOf(queries: number): number;
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
    admit(scope: AgentScope, queries: number): Admission;
    /**
     * Charge an admitted call to every enabled scope.
     *
     * @param scope - the calling agent's resolved scope.
     * @param queries - distinct query strings the call sent.
     * @returns the charged cost.
     */
    charge(scope: AgentScope, queries: number): number;
    /**
     * Drop the state belonging to one disposed session.
     *
     * Whole-tree counters are keyed by the top-level ancestor, so a disposed
     * *child* leaves the tree counter alone — only the tree root's disposal
     * clears it.
     *
     * @param sessionId - the session that is no longer live.
     */
    release(sessionId: string): void;
    /** Test-only view of the spend charged to one scope. */
    spendOf(kind: 'turn' | 'session' | 'tree', key: string): number;
}
/** Stable failure prefix so a deployment can grep its own traces. */
export declare const DENIAL_PREFIX = "web_search cost budget exhausted";
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
export declare function denialReason(refusal: Refusal, cost: number): string;
/**
 * The plugin's own resolved configuration, re-exported for callers that mount
 * it through the test seam rather than the loader.
 *
 * @param ctx - the plugin context.
 * @param config - the raw configuration section.
 */
export declare function apply(ctx: Context, config: Config): void;
/** Resolve the configuration section, filling every default. */
export declare function resolveConfig(config: Config): ResolvedConfig;
