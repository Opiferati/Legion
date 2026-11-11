'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE TEST CARD — the POST diagnostic of the Legion bus (2026-11-10)
//
// A real PC ships with a test card you seat in a slot to prove the slot
// works. This is that. It measures nothing, decides nothing, and must
// never be given a job: its only value is as a control on the bus itself.
//
// PASS CONDITION FOR THE WHOLE SLOT STANDARD: this card appears in the
// Warden's power-on list and runs nightly, with ZERO edits to warden.js
// after the loader exists. If it ever needs one, the slot is a fiction.
// ══════════════════════════════════════════════════════════════════════

function run(ctx) {
  const beat = { day: ctx.day, at: ctx.now().toISOString() };
  if (!ctx.board) {
    // No board is a thin reading, not a failure: the bus still carried us.
    return { status: 'thin', message: 'no blackboard on this pin', beat, posted: false };
  }
  try {
    ctx.board.post({
      topic: 'testcard.heartbeat',
      value: beat,
      source: 'testcard',
      confidence: 1,
      half_life_days: 1,
      if_changed: true,
    });
  } catch (e) {
    return { status: 'thin', message: `board unreachable: ${e.message}`, beat, posted: false };
  }
  ctx.log('bus is live');
  return { status: 'ok', beat, posted: true };
}

function summaryLine(r) {
  if (r.status === 'ok') {
    return `[TEST CARD] Bus is live — heartbeat posted for ${r.beat.day}.`;
  }
  return `[TEST CARD] ${r.status}${r.message ? ' — ' + r.message : ''}`;
}

module.exports = { run, summaryLine };
