'use strict';
// ══════════════════════════════════════════════════════════════════════
// LEGION SLOTS — the expansion bus (2026-11-10)
//
// A card declares itself in cards/<name>/card.json. The board finds it.
// Adding a card takes NO kernel edit: that is the whole point of a slot.
// If a card ever needs a change to warden.js to work, the slot does not
// exist and we have gone back to soldering.
//
// This module knows nothing about supervision, SQL, or what the work is.
// The Warden injects `child` so a card is supervised exactly like a
// soldered runner, and `report` so the board decides what the court hears.
// ══════════════════════════════════════════════════════════════════════

const fs   = require('node:fs');
const path = require('node:path');

// legion/2 (2026-11-10) added `authority` and made it mandatory for any card that
// needs the board pin, which INVALIDATES a legion/1 card written against the old
// rules. That is a breaking change, so the version moves. Refusing such a card with
// "this board speaks legion/2" tells its author the standard changed; refusing it
// under the old number would have told them they wrote it wrong.
const CONTRACT = 'legion/2';

// The honest statuses a card may return. Anything else is a fault, because
// a status the board cannot read is worse than an admitted error.
const STATUSES = new Set(['ok', 'thin', 'docked', 'missing', 'error']);

// The pinout. A card may ask for these and nothing else. Growing this list
// is how a slot standard rots into a god object, so each addition needs a
// written reason in "Legion - Slot Standard v1".
//
// `infer` added 2026-11-10, and here is the written reason the rule above
// demands. THESIS_G needs a card to call models. The alternatives were worse:
// a card doing its own HTTPS would reach past the pinout AND hold an API key,
// and soldering the thesis into warden.js would undo the morning's work. So
// the Forge owns every model call — one gate, one meter, no keys in cards —
// and the card reaches it through a pin like anything else.
// Appended rather than inserted, so Object.keys(ctx) still equals PINS in order.
const PINS = ['root', 'conf', 'day', 'board', 'log', 'now', 'infer'];

// What a card may be PERMITTED to do (2026-11-10, taken from IEAS-001's
// five-property contract: Identity, State, Interface, Responsibilities,
// Authority — the one this standard was missing).
//
// Unlike the pins, these are ENFORCED where the board can enforce them: the
// context handed to a card is BUILT to match its grants, so a card without
// board:write receives a board whose post() refuses out loud. Authority is
// not a note in a file that something checks later.
//
// The honest limit is unchanged: tier 1 shares one process, so this binds
// the SLOT, not the card's imagination. A card can still require('node:fs')
// behind the board's back. That is limitation 1 of the standard, and the fix
// for it is out-of-process cards, not a longer grant list.
const GRANTS = new Set(['board:read', 'board:write', 'model:infer']);

/** Why a manifest is refused, or null if it is sound. Refusals are reported,
 *  never thrown: one bad card must not keep the others off the bus. */
function validate(m, folder) {
  if (!m || typeof m !== 'object') return 'card.json is not an object';
  if (m.contract !== CONTRACT) {
    return `contract "${m.contract || '(none)'}" — this board speaks ${CONTRACT}`;
  }
  if (!m.name) return 'no name';
  // Lego law 7, enforced by the machine rather than by memory: the name in the
  // manifest must match the folder, so two cards can never answer to one name.
  if (m.name !== folder) return `name "${m.name}" does not match folder "${folder}"`;
  if (m.after !== undefined && !Array.isArray(m.after)) return 'after must be a list';
  if (m.needs !== undefined && !Array.isArray(m.needs)) return 'needs must be a list';
  const unknown = (m.needs || []).filter(p => !PINS.includes(p));
  if (unknown.length) return `asks for unknown pin(s): ${unknown.join(', ')}`;
  if (m.authority !== undefined && !Array.isArray(m.authority)) return 'authority must be a list';
  const ungranted = (m.authority || []).filter(g => !GRANTS.has(g));
  if (ungranted.length) return `claims unknown authority: ${ungranted.join(', ')}`;
  // A pin the card has no authority to use is a contradiction, and the board must
  // not resolve it quietly in either direction — the card has to say which half it
  // meant. Silently handing over a dead board would be the worse answer.
  if ((m.needs || []).includes('board')
      && !(m.authority || []).some(g => g.startsWith('board:'))) {
    return 'needs the board pin but claims no board:read or board:write authority';
  }
  if ((m.needs || []).includes('infer')
      && !(m.authority || []).includes('model:infer')) {
    return 'needs the infer pin but claims no model:infer authority';
  }
  if (m.timeout_min !== undefined && !(Number(m.timeout_min) > 0)) {
    return `timeout_min must be a positive number, not "${m.timeout_min}"`;
  }
  return null;
}

/** Walk cards/ and return what is on the bus and what was refused.
 *  No cards/ directory is an empty bus, not a fault — absence degrades. */
function discover(root) {
  const dir = path.join(root, 'cards');
  const cards = [], failures = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return { cards, failures }; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const slot = path.join(dir, e.name);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(slot, 'card.json'), 'utf8'));
      const bad = validate(m, e.name);
      if (bad) { failures.push({ name: e.name, reason: bad }); continue; }
      const mod = require(path.join(slot, m.entry || 'index.js'));
      if (typeof mod.run !== 'function') {
        failures.push({ name: m.name, reason: 'entry exports no run()' });
        continue;
      }
      cards.push({ name: m.name, manifest: m, mod, dir: slot });
    } catch (err) {
      failures.push({ name: e.name, reason: err.message });
    }
  }
  return { cards, failures };
}

/** Put the cards in declared order. `after` names a card that must run first;
 *  a name that is not on the bus (say "skald", a soldered runner) is a note
 *  about intent, not a blocker. Alphabetical within the constraints, so the
 *  same cards always produce the same order — provenance needs determinism.
 *  Throws on a cycle: a bus that cannot decide an order must not guess one. */
function order(cards) {
  const byName = new Map(cards.map(c => [c.name, c]));
  const state  = new Map();
  const out    = [];
  const visit = (c, trail) => {
    const s = state.get(c.name);
    if (s === 'done') return;
    if (s === 'open') {
      throw new Error(`load order cycle: ${trail.concat(c.name).join(' -> ')}`);
    }
    state.set(c.name, 'open');
    for (const dep of (c.manifest.after || [])) {
      const d = byName.get(dep);
      if (d && d !== c) visit(d, trail.concat(c.name));
    }
    state.set(c.name, 'done');
    out.push(c);
  };
  for (const c of cards) visit(c, []);
  return out;
}

/** The power-on self test. A PC lists its devices at boot; so does this one.
 *  A card that silently fails to load is the failure mode a slot standard
 *  invites, so every refusal is named out loud with its reason. */
function post(found, opts = {}) {
  const lines = [];
  const n = found.cards.length;
  lines.push(`Slots:    ${n} card(s)`
    + (n ? ` — ${found.cards.map(c => c.name).join(', ')}` : ' — bus empty'));
  // Authority and the effective deadline, per card. A card quietly holding more
  // authority than its job needs should be visible at boot, not discovered later.
  for (const c of found.cards) {
    const a = (c.manifest.authority || []).join(' ') || 'none';
    const d = typeof opts.deadlineFor === 'function' ? opts.deadlineFor(c) : null;
    lines.push(`          ${c.name} — authority: ${a}${d ? ` · deadline ${d}` : ''}`);
  }
  for (const f of found.failures) {
    lines.push(`          REFUSED ${f.name}: ${f.reason}`);
  }
  for (const m of requiredMissing(found, opts.required)) {
    lines.push(`          !! REQUIRED CARD MISSING — ${m.name}: ${m.reason}`);
  }
  if (restricted(found, opts.required)) {
    lines.push('          BUS RESTRICTED — a required card is absent, so NO cards will run.');
  }
  return lines;
}

/** Which required cards are not on the bus, and why.
 *
 *  Required-ness lives in the REGISTRY, not the manifest, and deliberately so:
 *  a manifest cannot declare the requirement of a folder that has been deleted,
 *  and that is the case that matters most. A card quietly vanishing is the
 *  failure a slot standard invites; only the board's own list catches it. */
function requiredMissing(found, required) {
  const present = new Set(found.cards.map(c => c.name));
  const refused = new Map(found.failures.map(f => [f.name, f.reason]));
  const out = [];
  for (const name of (required || [])) {
    if (present.has(name)) continue;
    out.push({ name, reason: refused.get(name) || 'not present on the bus' });
  }
  return out;
}

/** Fail closed, but only as far as the fault reaches. A missing required card is
 *  a configuration fault, so the BUS stops — every card, not just the broken one,
 *  because a bus running three of its four cards while reporting success is the
 *  kind of half-truth these laws exist to prevent.
 *
 *  It does NOT stop the night. The soldered stations are not on the bus, and
 *  halting their scans would cost a missed close on a live forward test — real,
 *  unrecoverable damage to a signed thesis, traded for a configuration problem
 *  that can be fixed in the morning. Fail closed on what is broken. */
function restricted(found, required) {
  return requiredMissing(found, required).length > 0;
}

/** A board shaped to the card's grants. Authority is not a note that something
 *  checks later: the card is handed only what it is allowed to call, and anything
 *  else refuses OUT LOUD rather than silently doing nothing. A method the
 *  underlying board does not offer is simply absent, so "not authorised" never
 *  gets blamed for "not implemented". */
function gateBoard(board, grants, name) {
  if (!board) return null;
  const out = {};
  const add = (m, grant) => {
    if (typeof board[m] !== 'function') return;
    out[m] = grants.includes(grant)
      ? board[m].bind(board)
      : () => { throw new Error(`not authorised: ${m}() needs ${grant}`); };
  };
  for (const m of ['read', 'query', 'topics', 'history']) add(m, 'board:read');
  for (const m of ['post', 'retract'])                    add(m, 'board:write');
  // The bus says who is speaking, not the card (2026-11-10). The board refuses a note
  // with no author, and a card that names its own author could name someone else's.
  // So when the bus knows the card's name, every note and retraction is stamped with
  // it here, overriding whatever the card wrote.
  if (name && grants.includes('board:write')) {
    if (typeof board.post === 'function')
      out.post = note => board.post({ ...(note || {}), author: name });
    if (typeof board.retract === 'function')
      out.retract = (id, o) => board.retract(id, { ...(o || {}), author: name });
  }
  return out;
}

/** The pinout handed to a card: exactly PINS, frozen. A card that reaches past
 *  this is soldered again, and freezing makes that obvious instead of subtle.
 *  `authority` is not a pin — it SHAPES one, by deciding which board methods the
 *  card actually receives. */
function context({ root, conf, day, board, log, now, infer, authority, name } = {}) {
  const grants = Array.isArray(authority) ? authority : [];
  return Object.freeze({
    root,
    conf: conf || {},
    day,
    board: gateBoard(board, grants, name),
    log: log || (() => {}),
    now: now || (() => new Date()),
    infer: gateInfer(infer, grants),
  });
}

/** The Forge, gated by the same rule as the board: a card without model:infer is
 *  not handed a quietly-dead function, it is handed one that refuses out loud.
 *  Absent when the board has no Forge to offer, so "not authorised" never gets
 *  blamed for "no inference available tonight". */
function gateInfer(infer, grants) {
  if (typeof infer !== 'function') return null;
  return grants.includes('model:infer')
    ? infer
    : () => { throw new Error('not authorised: infer() needs model:infer'); };
}

/** Run every card in order, each through the Warden's own `child` adapter so
 *  supervision, backoff and the disable latch apply exactly as they do to a
 *  soldered runner. A card's trouble is reported, never rethrown: one bad
 *  card must not take the night down. */
async function runAll(cards, { child, ctxFor, report }) {
  const results = [];
  for (const c of cards) {
    const ctx = ctxFor(c);
    if (ctx.conf.enabled === false) {
      const r = { status: 'docked', message: 'disabled in the registry' };
      report(c.name, r, `[${c.name.toUpperCase()}] Docked — ${r.message}.`);
      results.push({ name: c.name, ...r });
      continue;
    }
    // The card's own declared deadline travels with it (IEAS-001's "timeout in
    // the envelope"). Operator policy in the registry still outranks it: a card
    // asking for twenty minutes does not get to grant itself twenty minutes.
    const out = await child(c.name, () => c.mod.run(ctx),
                           { timeout_min: c.manifest.timeout_min });
    // rest_for_one: the board held this card back, so the board speaks for it.
    // A card that did not run does not get to narrate, and the REASON it was
    // held is the only useful thing here — losing it to a generic "docked"
    // would hide the one fact worth acting on.
    if (out.skipped) {
      const r = { status: 'docked', message: out.reason };
      report(c.name, r, `[${c.name.toUpperCase()}] Did not fly — ${r.message}.`);
      results.push({ name: c.name, ...r });
      continue;
    }
    let r;
    if (out.ok) r = out.value || { status: 'ok' };
    else        r = { status: 'error', message: out.error || out.reason };
    if (!r || !STATUSES.has(r.status)) {
      r = { status: 'error', message: `returned unreadable status "${r && r.status}"` };
    }
    let line;
    if (r.status === 'error') {
      line = `[${c.name.toUpperCase()}] PROBLEM: ${r.message}`;
    } else if (typeof c.mod.summaryLine === 'function') {
      try { line = c.mod.summaryLine(r); }
      catch (e) { line = `[${c.name.toUpperCase()}] ${r.status} (summaryLine threw: ${e.message})`; }
    } else {
      line = `[${c.name.toUpperCase()}] ${r.status}`;
    }
    report(c.name, r, line);
    results.push({ name: c.name, ...r });
  }
  return results;
}

module.exports = {
  CONTRACT, PINS, GRANTS, STATUSES,
  validate, discover, order, post, context, runAll,
  gateBoard, gateInfer, requiredMissing, restricted,
};
