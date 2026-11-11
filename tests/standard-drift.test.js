'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE DOCUMENT MUST MATCH THE CODE (2026-11-11)
//
// Declared weakness #3 of this standard reads: "The pinout and the grant list
// will be under constant pressure to grow. The rule is written down; nothing
// mechanically enforces it. The first time either grows without a reason in
// this document, the discipline is gone."
//
// It came true in nine days. The `infer` pin and the `model:infer` grant were
// added on 2026-11-10 for THESIS_G's panel card. The reason was good and was
// written down — in the loader's source, not in the standard, where the rule
// says it must go. The document said "six, frozen" while the code shipped
// seven, and two other documents copied the wrong number out of it.
//
// This file is the enforcement that was missing. The README carries machine-
// readable markers; these tests fail the moment the code and the document
// disagree, so the next pin cannot be added silently.
// ══════════════════════════════════════════════════════════════════════

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const slots  = require('../loader/slots.js');
const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

// The six pins the standard shipped with. Anything beyond these is an
// ADDITION and owes this document a written reason.
const FOUNDING_PINS = ['root', 'conf', 'day', 'board', 'log', 'now'];

function marker(name) {
  const m = new RegExp(`<!--\\s*${name}:\\s*([^>]*?)\\s*-->`).exec(README);
  assert.ok(m, `README is missing its <!-- ${name}: ... --> marker`);
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

test('the README names exactly the pins the loader offers', () => {
  assert.deepStrictEqual(marker('PINS'), slots.PINS,
    'the document and the code disagree about the pinout — fix both, in the same commit');
});

test('the README names exactly the grants the loader enforces', () => {
  assert.deepStrictEqual(marker('GRANTS').sort(), [...slots.GRANTS].sort(),
    'the document and the code disagree about authority');
});

test('the README names exactly the statuses the loader accepts', () => {
  assert.deepStrictEqual(marker('STATUSES').sort(), [...slots.STATUSES].sort());
});

test('the README states the contract version the loader speaks', () => {
  assert.ok(README.includes(slots.CONTRACT),
    `the README never mentions ${slots.CONTRACT}, so a card author cannot tell what to declare`);
});

test('every pin added since the standard shipped has a written reason here', () => {
  const added = slots.PINS.filter((p) => !FOUNDING_PINS.includes(p));
  const reasons = README.slice(README.indexOf('Written reasons for each addition'));
  assert.ok(reasons.length > 0, 'the README has no "Written reasons" section at all');
  for (const pin of added) {
    assert.match(reasons, new RegExp(`\`${pin}\``),
      `the \`${pin}\` pin exists in the code with no written reason in the standard — `
      + 'which is exactly the failure declared weakness #3 predicted');
  }
});

test('every grant beyond the board pair has a written reason here', () => {
  const added = [...slots.GRANTS].filter((g) => !g.startsWith('board:'));
  const reasons = README.slice(README.indexOf('Written reasons for each addition'));
  for (const grant of added) {
    assert.match(reasons, new RegExp(grant.replace(':', ':')),
      `the ${grant} grant exists in the code with no written reason in the standard`);
  }
});

test('the standard still admits the limit it cannot enforce', () => {
  // A declared weakness that quietly disappears from the document is worse
  // than one that was never written: it reads as solved.
  assert.match(README, /[Aa]uthority binds the slot, not the card/,
    'the in-process honesty limit must stay in the document while it is still true');
});
