'use strict';
// The Legion bus. The point of these tests is that a card gets on the bus
// without a kernel edit, and that a bad card is REFUSED OUT LOUD rather than
// vanishing — a silently missing card is the failure mode a slot invites.

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const slots = require('../loader/slots.js');

const OK_SRC = 'module.exports = { run: () => ({ status: "ok" }) };\n';
let seq = 0;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `legion-${process.pid}-${seq++}-`));
}

function makeCard(root, folder, manifest, src) {
  const dir = path.join(root, 'cards', folder);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== null) {
    fs.writeFileSync(path.join(dir, 'card.json'), JSON.stringify(manifest, null, 2));
  }
  const entry = (manifest && manifest.entry) || 'index.js';
  fs.writeFileSync(path.join(dir, entry), src || OK_SRC);
  return dir;
}

function card(name, extra) {
  return Object.assign({ contract: slots.CONTRACT, name, entry: 'index.js' }, extra || {});
}

test('no cards directory is an empty bus, not a fault', () => {
  const found = slots.discover(tmpRoot());
  assert.deepStrictEqual(found.cards, []);
  assert.deepStrictEqual(found.failures, []);
});

test('a sound card gets on the bus with no kernel edit', () => {
  const root = tmpRoot();
  makeCard(root, 'alpha', card('alpha', { needs: ['day', 'log'] }));
  const found = slots.discover(root);
  assert.strictEqual(found.failures.length, 0);
  assert.deepStrictEqual(found.cards.map(c => c.name), ['alpha']);
  assert.strictEqual(typeof found.cards[0].mod.run, 'function');
});

test('a card for another contract is refused, and the good one still loads', () => {
  const root = tmpRoot();
  makeCard(root, 'alpha', card('alpha'));
  makeCard(root, 'future', { contract: 'legion/9', name: 'future', entry: 'index.js' });
  const found = slots.discover(root);
  assert.deepStrictEqual(found.cards.map(c => c.name), ['alpha']);
  assert.strictEqual(found.failures.length, 1);
  assert.match(found.failures[0].reason, /legion\/9/, 'names the contract the card claimed');
  assert.ok(found.failures[0].reason.includes(slots.CONTRACT),
    'and the one this board speaks, so the author knows the standard moved');
});

test('the name in the manifest must match the folder', () => {
  const root = tmpRoot();
  makeCard(root, 'ravens', card('ravens-league'));
  const found = slots.discover(root);
  assert.strictEqual(found.cards.length, 0);
  assert.match(found.failures[0].reason, /does not match folder/);
});

test('a card asking for a pin that does not exist is refused by name', () => {
  const root = tmpRoot();
  makeCard(root, 'greedy', card('greedy', { needs: ['day', 'filesystem', 'network'] }));
  const found = slots.discover(root);
  assert.strictEqual(found.cards.length, 0);
  assert.match(found.failures[0].reason, /filesystem, network/);
});

test('an entry with no run() is refused, and unreadable json names the folder', () => {
  const root = tmpRoot();
  makeCard(root, 'mute', card('mute'), 'module.exports = { summaryLine: () => "x" };\n');
  const bad = path.join(root, 'cards', 'garbled');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'card.json'), '{ this is not json');
  const found = slots.discover(root);
  assert.strictEqual(found.cards.length, 0);
  const reasons = Object.fromEntries(found.failures.map(f => [f.name, f.reason]));
  assert.match(reasons.mute, /no run\(\)/);
  assert.ok(reasons.garbled, 'the garbled folder is named in the refusals');
});

test('after puts a card behind the one it reads from', () => {
  const root = tmpRoot();
  makeCard(root, 'zulu', card('zulu'));
  makeCard(root, 'league', card('league', { after: ['zulu'] }));
  const names = slots.order(slots.discover(root).cards).map(c => c.name);
  assert.ok(names.indexOf('zulu') < names.indexOf('league'), names.join(' -> '));
});

test('order is deterministic: same cards, same order, every boot', () => {
  const root = tmpRoot();
  for (const n of ['delta', 'bravo', 'charlie', 'alpha']) makeCard(root, n, card(n));
  const once  = slots.order(slots.discover(root).cards).map(c => c.name);
  const twice = slots.order(slots.discover(root).cards).map(c => c.name);
  assert.deepStrictEqual(once, twice);
  assert.deepStrictEqual(once, ['alpha', 'bravo', 'charlie', 'delta']);
});

test('after naming something that is not a card is intent, not a blocker', () => {
  const root = tmpRoot();
  makeCard(root, 'alpha', card('alpha', { after: ['skald', 'treasury'] }));
  const names = slots.order(slots.discover(root).cards).map(c => c.name);
  assert.deepStrictEqual(names, ['alpha']);
});

test('a cycle stops the bus with a readable trail rather than guessing', () => {
  const root = tmpRoot();
  makeCard(root, 'hen', card('hen', { after: ['egg'] }));
  makeCard(root, 'egg', card('egg', { after: ['hen'] }));
  assert.throws(
    () => slots.order(slots.discover(root).cards),
    (e) => /cycle/.test(e.message) && /hen/.test(e.message) && /egg/.test(e.message),
  );
});

test('the power-on list names every card and every refusal with its reason', () => {
  const root = tmpRoot();
  makeCard(root, 'alpha', card('alpha'));
  makeCard(root, 'future', { contract: 'legion/9', name: 'future', entry: 'index.js' });
  const lines = slots.post(slots.discover(root)).join('\n');
  assert.match(lines, /1 card\(s\)/);
  assert.match(lines, /alpha/);
  assert.match(lines, /REFUSED future/);
});

test('an empty bus says so out loud', () => {
  assert.match(slots.post({ cards: [], failures: [] })[0], /bus empty/);
});

// The Warden's own adapter shape: runners report trouble by returning
// {status:'error'}, which warden.js turns into a throw before supervision
// sees it. The fake below behaves the same way so these tests exercise the
// real contract rather than a friendlier one.
function fakeChild() {
  return async (name, fn) => {
    try {
      const v = await fn();
      if (v && v.status === 'error') throw new Error(v.message || 'runner reported an error');
      return { ok: true, value: v };
    } catch (e) { return { ok: false, error: e.message }; }
  };
}

function harness(conf) {
  const seen = [];
  return {
    seen,
    child: fakeChild(),
    ctxFor: () => slots.context({ root: '/x', conf: conf || {}, day: '2026-11-10' }),
    report: (name, r, line) => seen.push({ name, status: r.status, line }),
  };
}

test('the pinout is exactly the declared pins, and it is frozen', () => {
  const ctx = slots.context({ root: '/x', day: '2026-11-10' });
  assert.deepStrictEqual(Object.keys(ctx), slots.PINS);
  assert.ok(Object.isFrozen(ctx));
  assert.throws(() => { ctx.db = 'sneaking a pin in'; });
});

test('a card disabled in the registry docks without being run', () => {
  let ran = false;
  const cards = [{ name: 'alpha', manifest: {}, mod: { run: () => { ran = true; return { status: 'ok' }; } } }];
  const h = harness({ enabled: false });
  return slots.runAll(cards, h).then(() => {
    assert.strictEqual(ran, false);
    assert.strictEqual(h.seen[0].status, 'docked');
  });
});

test('a card that throws is an error with a PROBLEM line, and the next card still runs', async () => {
  const cards = [
    { name: 'broken', manifest: {}, mod: { run: () => { throw new Error('no data'); } } },
    { name: 'fine',   manifest: {}, mod: { run: () => ({ status: 'ok' }), summaryLine: () => '[FINE] all well' } },
  ];
  const h = harness();
  const out = await slots.runAll(cards, h);
  assert.strictEqual(out[0].status, 'error');
  assert.match(h.seen[0].line, /PROBLEM: no data/);
  assert.strictEqual(out[1].status, 'ok');
  assert.strictEqual(h.seen[1].line, '[FINE] all well');
});

test('a card returning status:error is a fault, not a success', async () => {
  const cards = [{ name: 'liar', manifest: {}, mod: { run: () => ({ status: 'error', message: 'source down' }) } }];
  const h = harness();
  const out = await slots.runAll(cards, h);
  assert.strictEqual(out[0].status, 'error');
  assert.match(h.seen[0].line, /source down/);
});

test('a status the board cannot read is a fault, not a shrug', async () => {
  const cards = [{ name: 'odd', manifest: {}, mod: { run: () => ({ status: 'fine, probably' }) } }];
  const h = harness();
  const out = await slots.runAll(cards, h);
  assert.strictEqual(out[0].status, 'error');
  assert.match(h.seen[0].line, /unreadable status/);
});

test('a summaryLine that throws does not take the night down', async () => {
  const cards = [{ name: 'rude', manifest: {}, mod: {
    run: () => ({ status: 'ok' }),
    summaryLine: () => { throw new Error('bad format string'); },
  } }];
  const h = harness();
  const out = await slots.runAll(cards, h);
  assert.strictEqual(out[0].status, 'ok');
  assert.match(h.seen[0].line, /summaryLine threw/);
});

test('rest_for_one: a skipped card docks with its reason', async () => {
  const cards = [{ name: 'league', manifest: {}, mod: { run: () => ({ status: 'ok' }) } }];
  const h = harness();
  h.child = async () => ({ skipped: true, reason: 'cavalier is down' });
  const out = await slots.runAll(cards, h);
  assert.strictEqual(out[0].status, 'docked');
  assert.match(h.seen[0].line, /cavalier is down/);
});

// ── The Test Card: the conformance proof ──────────────────────────────
// This is the one that matters. It reads the REAL cards/ directory, so if the
// slot standard and the shipped card ever drift apart, this test says so.

const testcard = require('../cards/testcard/index.js');

test('the Test Card is a conforming card on the real bus', () => {
  const found = slots.discover(path.join(__dirname, '..'));
  const names = found.cards.map(c => c.name);
  assert.deepStrictEqual(
    found.failures, [],
    `every card in cards/ must load: ${JSON.stringify(found.failures)}`,
  );
  assert.ok(names.includes('testcard'), `cards on the bus: ${names.join(', ') || '(none)'}`);
});

test('the Test Card declares only pins the standard offers', () => {
  const m = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cards', 'testcard', 'card.json'), 'utf8'));
  assert.strictEqual(m.contract, slots.CONTRACT);
  for (const pin of m.needs) assert.ok(slots.PINS.includes(pin), `unknown pin ${pin}`);
});

test('the Test Card posts a heartbeat when the board is on its pin', () => {
  const posted = [];
  const ctx = slots.context({
    day: '2026-11-10',
    board: { post: (n) => posted.push(n) },
    authority: ['board:write'],      // what cards/testcard/card.json declares
    now: () => new Date('2026-11-10T12:00:00Z'),
  });
  const r = testcard.run(ctx);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.posted, true);
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].topic, 'testcard.heartbeat');
  assert.strictEqual(posted[0].value.day, '2026-11-10');
  assert.strictEqual(posted[0].if_changed, true, 'a nightly heartbeat must not bloat the board');
  assert.match(testcard.summaryLine(r), /2026-11-10/);
});

test('no board is thin, not broken — the bus still carried the card', () => {
  const r = testcard.run(slots.context({ day: '2026-11-10' }));
  assert.strictEqual(r.status, 'thin');
  assert.strictEqual(r.posted, false);
  assert.match(testcard.summaryLine(r), /thin/);
});

test('a board that throws is reported, never swallowed', () => {
  const ctx = slots.context({
    day: '2026-11-10',
    board: { post: () => { throw new Error('database is locked'); } },
    authority: ['board:write'],
  });
  const r = testcard.run(ctx);
  assert.strictEqual(r.status, 'thin');
  assert.match(r.message, /database is locked/);
});

// ── Authority (2026-11-10) ───────────────────────────────────────────────
// Taken from IEAS-001's five-property contract. The point of these tests is
// that authority is ENFORCED at the pin, not recorded in a file and trusted.

test('a card claiming authority that does not exist is refused, by name', () => {
  const root = tmpRoot();
  makeCard(root, 'grabby', card('grabby', { authority: ['board:write', 'root:all', 'sudo'] }));
  const found = slots.discover(root);
  assert.strictEqual(found.cards.length, 0);
  assert.match(found.failures[0].reason, /root:all, sudo/);
});

test('needing the board while claiming no board authority is a contradiction, refused', () => {
  const root = tmpRoot();
  makeCard(root, 'muddle', card('muddle', { needs: ['board'], authority: [] }));
  const found = slots.discover(root);
  assert.strictEqual(found.cards.length, 0);
  assert.match(found.failures[0].reason, /no board:read or board:write/);
});

test('a write-only card gets post, and read refuses out loud', () => {
  const posted = [];
  const real = { post: (n) => posted.push(n), query: () => ['should not reach here'] };
  const b = slots.gateBoard(real, ['board:write']);
  b.post({ topic: 't' });
  assert.strictEqual(posted.length, 1);
  assert.throws(() => b.query({}), /not authorised: query\(\) needs board:read/);
});

test('a read-only card gets query, and post refuses out loud', () => {
  const real = { post: () => { throw new Error('must never be called'); }, query: () => ['a note'] };
  const b = slots.gateBoard(real, ['board:read']);
  assert.deepStrictEqual(b.query({}), ['a note']);
  assert.throws(() => b.post({ topic: 't' }), /not authorised: post\(\) needs board:write/);
});

test('a method the board does not offer is absent, not blamed on authority', () => {
  // Otherwise "not authorised" gets blamed for "not implemented", and someone
  // spends an evening granting permissions that were never the problem.
  const b = slots.gateBoard({ post: () => {} }, ['board:read', 'board:write']);
  assert.strictEqual(typeof b.post, 'function');
  assert.strictEqual(b.history, undefined);
  assert.strictEqual(b.retract, undefined);
});

test('the context builds the board from the grants, so the pin itself is gated', () => {
  const ctx = slots.context({
    day: '2026-11-10',
    board: { post: () => 'wrote', query: () => 'read' },
    authority: ['board:write'],
  });
  assert.strictEqual(ctx.board.post(), 'wrote');
  assert.throws(() => ctx.board.query(), /not authorised/);
  assert.deepStrictEqual(Object.keys(ctx), slots.PINS, 'authority is not a pin; it shapes one');
});

test('no authority at all means a board that refuses everything', () => {
  const ctx = slots.context({ board: { post: () => {}, query: () => {} } });
  assert.throws(() => ctx.board.post(), /not authorised/);
  assert.throws(() => ctx.board.query(), /not authorised/);
});

test('the power-on list prints each card authority', () => {
  const root = tmpRoot();
  makeCard(root, 'alpha', card('alpha', { needs: ['board'], authority: ['board:write'] }));
  const lines = slots.post(slots.discover(root)).join('\n');
  assert.match(lines, /alpha — authority: board:write/);
});

// ── Fail closed: required cards (2026-11-10) ─────────────────────────────

test('a required card that is simply gone is named, with no manifest to help', () => {
  const root = tmpRoot();
  makeCard(root, 'alpha', card('alpha'));
  const missing = slots.requiredMissing(slots.discover(root), ['alpha', 'vanished']);
  assert.deepStrictEqual(missing.map(m => m.name), ['vanished']);
  assert.match(missing[0].reason, /not present on the bus/);
});

test('a required card that was REFUSED carries its refusal reason, not a shrug', () => {
  const root = tmpRoot();
  makeCard(root, 'future', { contract: 'legion/9', name: 'future', entry: 'index.js' });
  const missing = slots.requiredMissing(slots.discover(root), ['future']);
  assert.strictEqual(missing.length, 1);
  assert.match(missing[0].reason, /legion\/9/);
});

test('one missing required card restricts the WHOLE bus, not just itself', () => {
  const root = tmpRoot();
  makeCard(root, 'alpha', card('alpha'));
  makeCard(root, 'bravo', card('bravo'));
  const found = slots.discover(root);
  assert.strictEqual(slots.restricted(found, ['alpha', 'bravo']), false);
  assert.strictEqual(slots.restricted(found, ['alpha', 'charlie']), true,
    'two healthy cards do not excuse a third being gone');
});

test('nothing required means nothing to restrict', () => {
  const found = slots.discover(tmpRoot());
  assert.strictEqual(slots.restricted(found, []), false);
  assert.strictEqual(slots.restricted(found, undefined), false);
});

test('the power-on list shouts when the bus is restricted', () => {
  const root = tmpRoot();
  makeCard(root, 'alpha', card('alpha'));
  const lines = slots.post(slots.discover(root), { required: ['alpha', 'gone'] }).join('\n');
  assert.match(lines, /REQUIRED CARD MISSING — gone/);
  assert.match(lines, /BUS RESTRICTED/);
  assert.match(lines, /NO cards will run/);
});

test('the power-on list stays quiet when every required card is seated', () => {
  const root = tmpRoot();
  makeCard(root, 'alpha', card('alpha'));
  const lines = slots.post(slots.discover(root), { required: ['alpha'] }).join('\n');
  assert.doesNotMatch(lines, /RESTRICTED/);
  assert.doesNotMatch(lines, /MISSING/);
});

test('a card declaring a nonsense deadline is refused rather than silently defaulted', () => {
  const root = tmpRoot();
  makeCard(root, 'eager', card('eager', { timeout_min: 0 }));
  makeCard(root, 'sloppy', card('sloppy', { timeout_min: 'soon' }));
  const found = slots.discover(root);
  assert.strictEqual(found.cards.length, 0);
  assert.strictEqual(found.failures.length, 2);
  for (const f of found.failures) assert.match(f.reason, /timeout_min must be a positive number/);
});
