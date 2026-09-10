import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SearchBudget,
  DENIAL_PREFIX,
  countQueries,
  currentTurn,
  denialReason,
  resolveConfig,
  resolveRootId,
  resolveScope,
} from '../lib/index.js'

const DEFAULTS = resolveConfig({})

test('the documented defaults bound a 4-query call at twice the per-call ceiling', () => {
  // 4 queries x 5 native searches = 20 estimated requests, over the 10 default.
  const budget = new SearchBudget(DEFAULTS)
  assert.equal(budget.admit(scopeOfNow('s'), 4).admitted, false)
})

/** A session double with an id, an optional durable parent, and a turn log. */
function session({ id = 's', parent, turns = [1] } = {}) {
  const events = []
  for (const turn of turns) events.push({ type: 'turn/start', data: { turn } })
  return {
    id,
    header: parent === undefined ? {} : { parentSession: parent },
    seq: events.length,
    snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
  }
}

function agent(id, s) {
  return { session: { ...s, id } }
}

/** A lookup backed by a fixed roster of live agents. */
function roster(list) {
  const byId = new Map(list.map(a => [a.session.id, a]))
  return id => byId.get(id)
}

const NOBODY = () => undefined

/** A bare scope with no lineage, for cost-only assertions. */
function scopeOfNow(id) {
  return { sessionId: id, turn: 1, rootId: id }
}

/* -------------------------------------------------------------------------- */
/* countQueries                                                               */
/* -------------------------------------------------------------------------- */

test('countQueries counts distinct non-blank strings', () => {
  assert.equal(countQueries({ queries: ['a', 'b', 'c'] }), 3)
})

test('countQueries collapses exact duplicates the way tool-web does', () => {
  assert.equal(countQueries({ queries: ['a', 'b', 'a', 'b'] }), 2)
})

test('countQueries trims before comparing, so padded duplicates collapse too', () => {
  assert.equal(countQueries({ queries: ['  a  ', 'a'] }), 1)
})

test('countQueries ignores blank strings and non-strings', () => {
  assert.equal(countQueries({ queries: ['a', '', '   ', 7, null, undefined, {}, []] }), 1)
})

test('countQueries reports zero for an unparsable argument rather than guessing', () => {
  for (const raw of [undefined, null, 'queries', 3, [], {}, { queries: 'a' }, { queries: {} }]) {
    assert.equal(countQueries(raw), 0, `expected 0 for ${JSON.stringify(raw)}`)
  }
})

/* -------------------------------------------------------------------------- */
/* resolveRootId                                                              */
/* -------------------------------------------------------------------------- */

test('a session with no parent is its own tree root', () => {
  assert.equal(resolveRootId(session(), 'root', NOBODY), 'root')
})

test('resolveRootId walks the durable parent chain to the top-level ancestor', () => {
  const root = agent('root', session())
  const mid = agent('mid', session({ parent: 'root' }))
  const leaf = agent('leaf', session({ parent: 'mid' }))
  const lookup = roster([root, mid, leaf])
  assert.equal(resolveRootId(leaf.session, 'leaf', lookup), 'root')
})

test('resolveRootId stops at the first ancestor that is no longer live', () => {
  // `mid` was persisted and disposed; its id still names the tree.
  const leaf = agent('leaf', session({ parent: 'mid' }))
  assert.equal(resolveRootId(leaf.session, 'leaf', roster([leaf])), 'mid')
})

test('resolveRootId terminates on a cyclic lineage instead of looping forever', () => {
  const a = session({ parent: 'b' })
  const b = agent('b', session({ parent: 'a' }))
  const lookup = id => (id === 'b' ? b : undefined)
  assert.equal(resolveRootId(a, 'a', lookup), 'b')
})

/* -------------------------------------------------------------------------- */
/* currentTurn                                                                */
/* -------------------------------------------------------------------------- */

test('currentTurn reads the latest turn/start in the log', () => {
  assert.equal(currentTurn(session({ turns: [1, 2, 3] })), 3)
})

test('currentTurn is 0 before any turn starts', () => {
  assert.equal(currentTurn(session({ turns: [] })), 0)
})

test('currentTurn tolerates a session double with no snapshot accessor', () => {
  assert.equal(currentTurn({ header: {}, seq: 5 }), 0)
})

test('currentTurn ignores events that carry no numeric turn', () => {
  const s = {
    header: {},
    seq: 2,
    snapshotEvents: () => [{ type: 'turn/start', data: {} }, { type: 'turn/end', data: { turn: 9 } }],
  }
  assert.equal(currentTurn(s), 0)
})

/* -------------------------------------------------------------------------- */
/* resolveScope                                                               */
/* -------------------------------------------------------------------------- */

test('resolveScope returns the session id, current turn, and tree root together', () => {
  const root = agent('root', session({ turns: [1, 2] }))
  const child = agent('child', session({ parent: 'root', turns: [1] }))
  const lookup = roster([root, child])
  assert.deepEqual(resolveScope(child, lookup), { sessionId: 'child', turn: 1, rootId: 'root' })
})

/* -------------------------------------------------------------------------- */
/* cost model                                                                 */
/* -------------------------------------------------------------------------- */

test('cost is distinct queries x per-request native searches', () => {
  const budget = new SearchBudget(resolveConfig({ queriesPerRequest: 5 }))
  assert.equal(budget.costOf(4), 20)
  assert.equal(budget.costOf(0), 0)
})

test('queriesPerRequest is floored at 1 so a miscount can never make a call free', () => {
  const budget = new SearchBudget(resolveConfig({ queriesPerRequest: 0 }))
  assert.equal(budget.costOf(3), 3)
})

/* -------------------------------------------------------------------------- */
/* admission and charging                                                     */
/* -------------------------------------------------------------------------- */

function scopeOf(id, parent) {
  return { sessionId: id, turn: 1, rootId: parent ?? id }
}

test('a call within every budget is admitted', () => {
  const budget = new SearchBudget(resolveConfig({ perCall: 10, perTree: 60 }))
  const scope = scopeOf('s')
  assert.equal(budget.admit(scope, 2).admitted, true)
})

test('per-call refuses a call that exceeds the per-call ceiling', () => {
  const budget = new SearchBudget(resolveConfig({ perCall: 10, perTree: 0 }))
  const admission = budget.admit(scopeOf('s'), 3) // 3 x 5 = 15 > 10
  assert.equal(admission.admitted, false)
  assert.equal(admission.cost, 15)
  assert.deepEqual(admission.refusal, { scope: 'per-call', limit: 10, spent: 0 })
})

test('a disabled scope (0) never refuses', () => {
  const budget = new SearchBudget(resolveConfig({ perCall: 0, perTurn: 0, perSession: 0, perTree: 0 }))
  assert.equal(budget.admit(scopeOf('s'), 1000).admitted, true)
})

test('per-tree accumulates the spend of a parent and its descendants', () => {
  const budget = new SearchBudget(resolveConfig({ perCall: 0, perTree: 20 }))
  const root = scopeOf('root')
  const child = scopeOf('child', 'root')
  assert.equal(budget.charge(root, 2), 10)
  assert.equal(budget.admit(child, 2).admitted, true) // 10 + 10 = 20, not over
  budget.charge(child, 2)
  const admission = budget.admit(root, 1) // 20 + 5 = 25 > 20
  assert.equal(admission.admitted, false)
  assert.equal(admission.refusal.scope, 'per-tree')
  assert.equal(admission.refusal.spent, 20)
})

test('per-session tracks one session and independent sessions keep separate budgets', () => {
  const budget = new SearchBudget(resolveConfig({ perCall: 0, perSession: 10 }))
  budget.charge(scopeOf('a'), 2)
  assert.equal(budget.admit(scopeOf('a'), 1).admitted, false)
  assert.equal(budget.admit(scopeOf('b'), 1).admitted, true)
})

test('per-turn tracks one turn and a later turn starts fresh', () => {
  const budget = new SearchBudget(resolveConfig({ perCall: 0, perTurn: 10 }))
  budget.charge({ sessionId: 's', turn: 1, rootId: 's' }, 2)
  assert.equal(budget.admit({ sessionId: 's', turn: 1, rootId: 's' }, 1).admitted, false)
  assert.equal(budget.admit({ sessionId: 's', turn: 2, rootId: 's' }, 1).admitted, true)
})

test('the narrowest exhausted scope is the one named in the refusal', () => {
  const budget = new SearchBudget(resolveConfig({ perCall: 10, perTree: 10 }))
  const admission = budget.admit(scopeOf('s'), 3) // 15 over both
  assert.equal(admission.refusal.scope, 'per-call')
})

test('an admission that is refused spends nothing', () => {
  const budget = new SearchBudget(resolveConfig({ perCall: 10, perSession: 0, perTree: 0 }))
  const scope = scopeOf('s')
  assert.equal(budget.admit(scope, 3).admitted, false)
  assert.equal(budget.spendOf('session', 's'), 0)
})

/* -------------------------------------------------------------------------- */
/* release                                                                    */
/* -------------------------------------------------------------------------- */

test('release drops the turn and session state of one session', () => {
  const budget = new SearchBudget(resolveConfig({ perCall: 0, perTurn: 100, perSession: 100 }))
  budget.charge(scopeOf('s'), 2)
  assert.equal(budget.spendOf('session', 's'), 10)
  budget.release('s')
  assert.equal(budget.spendOf('session', 's'), 0)
  assert.equal(budget.spendOf('turn', 's\u00001'), 0)
})

test('releasing a child leaves the shared tree counter intact', () => {
  const budget = new SearchBudget(resolveConfig({ perCall: 0, perTree: 100 }))
  budget.charge(scopeOf('child', 'root'), 2)
  assert.equal(budget.spendOf('tree', 'root'), 10)
  budget.release('child')
  assert.equal(budget.spendOf('tree', 'root'), 10)
})

/* -------------------------------------------------------------------------- */
/* denial text                                                                */
/* -------------------------------------------------------------------------- */

test('denialReason carries the stable prefix, the scope, and the numbers', () => {
  const reason = denialReason({ scope: 'per-tree', limit: 60, spent: 55 }, 25)
  assert.ok(reason.startsWith(`${DENIAL_PREFIX} (per-tree)`))
  assert.match(reason, /budget is 60/)
  assert.match(reason, /55 request\(s\) have already been spent/)
  assert.match(reason, /Do not retry/)
})

test('denialReason points at the deployment, not at the tool call', () => {
  const reason = denialReason({ scope: 'per-call', limit: 10, spent: 0 }, 15)
  assert.match(reason, /deployment configuration/)
})

/* -------------------------------------------------------------------------- */
/* config                                                                     */
/* -------------------------------------------------------------------------- */

test('resolveConfig fills every documented default', () => {
  assert.deepEqual(DEFAULTS, {
    toolName: 'web_search',
    queriesPerRequest: 5,
    perCall: 10,
    perTurn: 0,
    perSession: 0,
    perTree: 60,
    enforce: true,
  })
})

test('resolveConfig preserves explicit values, including a disabling 0', () => {
  const resolved = resolveConfig({ perTree: 0, perCall: 3, enforce: false, toolName: 'search_web' })
  assert.equal(resolved.perTree, 0)
  assert.equal(resolved.perCall, 3)
  assert.equal(resolved.enforce, false)
  assert.equal(resolved.toolName, 'search_web')
})

/* -------------------------------------------------------------------------- */
/* the #6106 workload                                                         */
/* -------------------------------------------------------------------------- */

test('the reported #6106 fan-out is refused by the default tree budget', () => {
  // 198 web_search calls over one session: the default per-tree ceiling of 60
  // estimated requests stops the run long before the reported 854. `perCall` is
  // disabled here so the runs measure the TREE ceiling in isolation (the
  // default per-call ceiling of 10 would refuse the very first call).
  const budget = new SearchBudget(resolveConfig({ perCall: 0 }))
  const root = scopeOf('root')
  const child = scopeOf('child', 'root')
  const grandchild = scopeOf('grandchild', 'root')
  let admitted = 0
  for (const scope of [root, child, grandchild, child, root]) {
    for (let round = 0; round < 10; round += 1) {
      // each call carries the 4 queries `searchMaxQueries` allows
      if (budget.admit(scope, 4).admitted) {
        budget.charge(scope, 4)
        admitted += 1
      }
    }
  }
  // 4 queries x 5 native searches = 20 estimated requests per call, so the
  // default 60-request tree ceiling admits exactly three calls.
  assert.equal(admitted, 3)
  assert.equal(budget.spendOf('tree', 'root'), 60)
})
