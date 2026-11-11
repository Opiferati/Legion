# Legion — the Slot Standard

**A computer made of agents — one agent per component, modular and swappable.**

This repository is the standard itself: the loader, its tests, and the conformance card. It is deliberately not a host. The first host is the Norse Imperium, which *consumes* Legion rather than containing it.

**Contract: `legion/2`.** A card declares itself and the board finds it. **Adding a card costs zero kernel edits.** That sentence is the whole standard; everything below is how it is kept true.

## Repository layout

```
loader/slots.js        the standard, implemented
tests/slots.test.js    39 tests, including the conformance proof
cards/testcard/        the conformance card — proves the standard works
README.md              this document, which the tests check against the code
```

## History

`legion/1` shipped 2026-11-10. `legion/2` the same day added `authority` and `timeout_min`, and made authority **mandatory for any card needing the board pin** — which invalidates a `legion/1` card written against the old rules, so the version moved. Refusing such a card with *"this board speaks legion/2"* tells its author the standard changed; tightening quietly under the old number would have told them they wrote it wrong. That is the entire reason the `contract` field exists.

Extracted into its own repository 2026-11-11, out of `C:\Imperium\runners\slots.js`. A versioned contract with a version negotiation and no home of its own is a thing that knows it should be distributable but has nowhere to go.

---

## A card

A folder under `cards/<name>/` with two files.

### `card.json`

```json
{
  "contract": "legion/2",
  "name": "attempts",
  "entry": "index.js",
  "stage": "nightly",
  "after": [],
  "needs": ["root", "board", "log"],
  "authority": ["board:write"],
  "timeout_min": 2,
  "purpose": "One line on what this card is for."
}
```

| Field | Rule |
|---|---|
| `contract` | Must be `legion/2`. Another contract is refused **by name**, not silently skipped. |
| `name` | Required, and **must match the folder name.** Two cards can never answer to one name, and the machine enforces it rather than trusting memory. |
| `entry` | Defaults to `index.js`. |
| `stage` | `nightly` today. Reserved for other stages. |
| `after` | Names that must run first. A name that is not a card is a statement of intent, not a blocker. |
| `needs` | Which pins the card uses. A pin that does not exist is refused **with the offending pin named**. |
| `authority` | **What the card is permitted to do.** Required if `needs` includes a privileged pin. An unknown grant is refused by name. |
| `timeout_min` | Optional, the card's own deadline. Operator policy outranks it. A non-positive or non-numeric value is refused rather than silently defaulted. |

### `index.js`

```js
function run(ctx) { ... return { status: 'ok', ... }; }
function summaryLine(result) { return '[CARD] one line for the court.'; }
module.exports = { run, summaryLine };
```

`run(ctx)` may be sync or async. `summaryLine` is optional; without it the board writes a plain status line.

**A card must do no work when it is required.** `discover()` requires the entry at boot, so anything at module top level runs at boot — outside supervision and outside the nightly budget.

---

## The pinout — seven pins, frozen

<!-- PINS: root, conf, day, board, log, now, infer -->

`ctx` carries exactly these, frozen:

| Pin | What it is |
|---|---|
| `root` | The host's root path. |
| `conf` | This card's own registry block, or `{}`. |
| `day` | The host's date string for tonight. |
| `board` | Shared memory, **shaped to the card's authority**, or `null`. |
| `log(msg)` | Writes one attributed line. |
| `now()` | The clock. Injected so tests can hold time still. |
| `infer(...)` | A model call, **only** with `model:infer`. |

**The pinout is frozen and this list is closed.** A card reaching past it is soldered again. Growing the list is how a slot standard rots into a god object, so **every addition needs a written reason in this document** — a pin, like a PCIe lane, is a commitment to every card that comes after.

`authority` is **not** a pin. It *shapes* one.

### Written reasons for each addition

- **`infer`, added 2026-11-10 with the `model:infer` grant.** THESIS_G needs a card that can call models: the thesis measures whether a panel of different model tiers gives genuinely independent judgments, which cannot be done by a card that cannot reach a model. The alternatives were worse — a card shelling out to its own client would put model calls outside the ledger and outside the budget wall, and handing every card a model would give the power to cards that have no use for it. A gated pin keeps the spend metered and the authority visible at boot.

  *This reason was recorded in the loader's source on 2026-11-10 and moved into this document on 2026-11-11, where the rule above says it belongs. The document had said "six, frozen" for nine days while the code carried seven. Declared weakness #3 came true inside a fortnight: the rule was written down and nothing enforced it. There is now a test that fails when the code and this document disagree.*

---

## Authority — three grants, enforced not recorded

<!-- GRANTS: board:read, board:write, model:infer -->

*Taken from IEAS-001's component contract — Identity, State, Interface, Responsibilities, Authority — which named the one thing `legion/1` was missing.*

The point is that authority is **enforced, not recorded.** The context handed to a card is *built* from its grants:

- `board:write` → a working `post()`. Its `query()` throws `not authorised: query() needs board:read`.
- `board:read` → a working `query()`. Its `post()` throws.
- No board grant at all → a board that refuses everything.
- `model:infer` → a working `infer()`. Without it, `infer()` throws.
- **A method the underlying board does not offer is simply *absent* rather than throwing "not authorised"** — otherwise permission gets blamed for "not implemented", and somebody spends an evening granting permissions that were never the problem.

Two refusals at load time: an unknown grant, **with the offending grant named**; and `needs: ["board"]` with no `board:*` grant, refused as a contradiction. The board must not resolve that quietly in either direction — silently handing over a dead board is the worse answer. Same for `needs: ["infer"]` without `model:infer`.

**The honest limit, unchanged:** tier 1 shares one process, so this binds the **slot**, not the card's imagination. A card can still `require('node:fs')` behind the board's back. That is limitation 1 below, and the fix is out-of-process cards — not a longer grant list.

---

## The statuses

<!-- STATUSES: ok, thin, docked, missing, error -->

A card returns one of five. Anything else is treated as a fault, because a status the board cannot read is worse than an admitted error.

| Status | Means |
|---|---|
| `ok` | Did the work. |
| `thin` | Ran, but the data was partial. Honest, not a failure. |
| `docked` | Deliberately didn't run (closed, disabled, not due). |
| `missing` | A dependency wasn't there. Reported, but not escalated. |
| `error` | Failed. The supervisor counts it. |

## Who speaks for a card

**A card that didn't run doesn't get to narrate.** When the board docks a card — disabled in the registry, or held back because a dependency is down — the *board* writes the line, not the card. The card has no idea why it was held, so letting it write the line throws away the only useful fact.

*This was a real bug, caught by a test while the loader was being written: a card held back by `rest_for_one` was reported as a bare `[LEAGUE] docked` instead of "Did not fly — cavalier is down." The first is noise; the second is actionable.*

## Existence vs. policy

A clean split, mirroring real hardware — the card declares itself, the BIOS holds the settings.

- **The folder says what a card IS.** Name, entry, order, pins, authority, its own preferred deadline.
- **The host's registry says how the board TREATS it.** `enabled`, timeouts, directories, supervision, and which cards are required.

So `enabled: false` docks a card without removing it, and supervision limits are tuned without touching the card. Registry keys use underscores, card folders use hyphens; the loader checks both.

> `slots` is a reserved registry key in the host. Don't name a card `slots`.

## Deadlines

Precedence, in order:

1. `registry.supervision.<card>.timeout_min` — the operator's explicit ruling
2. `registry.<card>.timeout_min` — also the operator's
3. `card.json`'s `timeout_min` — **the card's own**
4. the 10-minute default

**The card comes third on purpose.** A declared deadline is useful — it travels with the card, no registry entry needed — but a card asking for thirty minutes must not *get* thirty minutes over the operator's objection. **There is no way to opt out of a deadline**; a child with no deadline is the bug a deadline mechanism exists to close.

## Load order

Topological by `after`, **alphabetical within the constraints**, so the same cards always produce the same order. Provenance needs determinism — "it ran in a different order that night" must never be an available excuse.

A cycle **stops the bus** with the trail printed (`load order cycle: hen -> egg -> hen`). A bus that cannot decide an order must not guess one.

## POST

A real PC lists its devices at boot. So does this one — with each card's authority and effective deadline, so a card holding more than its job needs is visible here rather than discovered later:

```
Slots:    4 card(s) — attempts, diskwatch, panel, testcard
          attempts — authority: board:write · deadline 2 min
          diskwatch — authority: none · deadline 1 min
          panel — authority: board:write model:infer · deadline 8 min
          testcard — authority: board:write · deadline 1 min
          REFUSED future: contract "legion/9" — this board speaks legion/2
```

This exists because **silent non-loading is the failure mode a slot standard invites.** A folder with a typo'd manifest just doesn't load, and nobody notices for a month.

## Fail closed — required cards

The host's registry names cards that must be present and loadable. If one is absent or refused, **no cards run** and the operator is told at top priority.

Three decisions behind that:

- **Required-ness lives in the host's registry, not in a manifest.** A manifest cannot declare the requirement of a folder that has been deleted — and that is the case that matters most.
- **It stops every card, not just the broken one.** A bus running three of its four cards while reporting success is the kind of half-truth these laws exist to prevent.
- **It stops the bus, not the host.** Work that is not on the bus keeps running. Fail closed on what is broken — halting unrelated work that carries a real commitment trades recoverable damage for unrecoverable damage.

## Conformance: the Test Card

`cards/testcard/` posts a heartbeat and does nothing else, on purpose. It is the control on the bus itself.

**The pass condition for the entire standard:** the Test Card appears in the power-on list and runs with **zero edits to the host's kernel.** If it ever needs one, the slot is a fiction.

---

## Declared weaknesses

Including the ones that might sink it.

1. **Tier 1 only — everything is in-process.** A card can lie in its manifest and reach straight past the pins; `Object.freeze` and the gated board catch an accidental reach, not a determined one. Real isolation needs out-of-process cards. **Authority binds the slot, not the card.** Don't claim otherwise.
2. **No deadline *inside* a card's run.** The bell is at the host's child boundary, so a card that hangs is abandoned — but a card cannot yet bound its own sub-steps, and the abandoned work keeps running. Real cancellation needs an `AbortSignal` threaded through.
3. **The pinout and the grant list are under constant pressure to grow.** **This one has already come true once** — see the `infer` note above. There is now a test comparing the code against this document, which is the first mechanical enforcement this weakness has ever had.
4. **Requiring at boot cuts both ways.** A syntax error is caught at boot, which is good. A card doing work at module level runs it at boot, unsupervised and off-budget, which is bad — and nothing currently detects it.
5. **Restricted mode has no auto-recovery.** It clears when the card is restored and the host restarts. Nothing re-checks mid-run.

## Tier 2, not built

Out-of-process cards: real isolation, credentials per card, a card crash that cannot touch the kernel. The only upgrade that changes what this standard can honestly *claim*. Costs a wire protocol and a new failure mode where a card is unreachable rather than broken.
