# Commercial Baccarat Data Checklist

Research date: 2026-05-24.

## Sources Reviewed

- RoundVix real-time baccarat API: `https://roundvix.com/`
- Wizard of Odds baccarat card counting: `https://wizardofodds.com/games/baccarat/card-counting/`
- Wizard of Odds baccarat card-removal appendix: `https://wizardofodds.com/games/baccarat/appendix/2/`
- Wizard of Odds Lucky 6 count: `https://wizardofodds.com/games/baccarat/counting-lucky-6/`

## Must Record

- Provider name and source URL/session health.
- Provider table id and visible table code.
- Game round id, shoe id when available, round number.
- Result: banker, player, tie.
- Side results: banker pair, player pair, lucky six, natural, score distribution when available.
- Banker/player total points.
- Banker/player card list, raw provider card codes, rank, suit, baccarat point.
- All five roads: bead plate, big road, big eye road, small road, cockroach road.
- Timestamps: card observed, result observed, inserted, last websocket, heartbeat.
- Source event type: live result, raw card, hall snapshot, manual.
- Void/cancel/closed-round notices, because providers can invalidate rounds after the fact.
- Data quality flags: duplicate slot, non-positive round number, table alias mismatch, missing cards.

## Prediction Notes

- Road and result patterns should be treated as historical search only.
- Card composition can change probabilities slightly because baccarat uses a finite shoe.
- Eight decks means 416 cards and 32 cards per rank at shoe start.
- Card counting/card-removal effects are generally small for main Banker/Player bets.
- Lucky 6 is much more sensitive to sixes and nearby ranks, but remains a high-variance side bet.
- Commercial models should always include backtests, source coverage, and confidence labels.

## Baijia Implementation

- Live Allbet events are preferred over hall snapshots.
- Old `getGameHall` snapshot data is excluded from prediction when enough live data exists.
- `/api/quality` audits coverage, duplicates, aliases, and card coverage.
- `/api/backtest` runs walk-forward testing of stored predictions.
- `/api/shoe` reports 8-deck remaining-card estimates by table.
- Main-result pick is conservative: Banker is default unless Player exceeds Banker by a 7 percentage-point model margin; Tie is reported but not used as the main pick.
