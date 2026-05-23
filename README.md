# Baijia Pro

Allbet baccarat recorder, roadmap dashboard, six-hand sequence statistics, PWA, and Capacitor mobile wrapper.

## What It Records

- Tables: B601 B602 B603 B604 B605 B201 B202 B203 Q501 Q502 Q601 Q701 Q702 Q201 Q202 Q204 B618 B219 B220 B501 B502 B503 B504 B505 B506 B507 C501 C701 C201 C202
- Roadmaps: 珠盤, 大路, 大眼仔, 小路, 蟑螂路
- Results: 莊, 閒, 和局, 莊對, 閒對, 幸運六
- Cards: Allbet live raw card events are stored as banker/player card codes, ranks, and baccarat points when available.
- Prediction: enter or reuse the latest six hands, then compare historical matches, stored results, and recorded 8-deck shoe composition.

Predictions are historical statistics only. Baccarat remains random and no result is guaranteed.

## Card Shoe Model

Each baccarat table is modeled as an 8-deck shoe:

- 8 decks x 52 cards = 416 cards.
- Each rank has 32 cards at the start of a shoe.
- 10/J/Q/K count as baccarat point 0.
- A counts as 1, 2-9 count as face value.

When Allbet sends card data, Baijia stores the banker/player cards and subtracts those ranks from the current table's estimated shoe. The next-hand estimate blends baseline rates, historical six-hand pattern statistics, and the remaining-card simulation. This is for analysis only and does not guarantee future outcomes.

The final main-result pick uses a conservative commercial rule:

- Show full percentages for Banker, Player, Tie, pairs, and Lucky 6.
- Never use Tie as the main pick because the base house edge is high.
- Default to Banker unless Player is at least 7 percentage points higher than Banker in the blended model.
- Keep `rawPick` in the API response to show the highest raw probability before the conservative rule.

Card model API:

```http
GET /api/shoe?tableCode=B601
```

Quality and backtest APIs:

```http
GET /api/quality
GET /api/backtest?tableCode=B601&limit=500&warmup=40
```

## Local Run

```powershell
cd C:\Users\Administrator\Baijia
npm install
npm start
```

Open:

```text
http://localhost:4173
```

## 24 Hour Recorder

Install the Windows scheduled task and start the background daemon:

```powershell
cd C:\Users\Administrator\Baijia
powershell -ExecutionPolicy Bypass -File scripts\install-windows-task.ps1
```

The task starts `src/daemon.js`, which supervises:

- `src/server.js`
- `src/scraper.js`

Logs are written to `logs\server.log`, `logs\server.err`, `logs\scraper.log`, and `logs\scraper.err`. Data is stored in `data\baijia.sqlite`.

Remove the scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-windows-task.ps1
```

## Android APK

```powershell
cd C:\Users\Administrator\Baijia
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1
```

APK output:

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

This repository also includes the latest local debug build at:

```text
dist\Baijia-Pro-debug.apk
```

If Android SDK is not installed locally, push to GitHub and run the `Android APK` workflow. It uploads `baijia-debug-apk` as an artifact.

## iPhone

The fastest iPhone version is the PWA:

1. Keep the server running on a public HTTPS domain or a LAN address reachable by the phone.
2. Open the site in Safari.
3. Use Share -> Add to Home Screen.

For App Store/TestFlight IPA builds, use the Capacitor iOS flow on macOS with Xcode. See `docs/ios-build.md`.

## Runtime Settings

The app reads data from an API base URL stored in the app settings. Data can be updated in the SQLite database or through the API without reinstalling the APK/PWA.

Manual write API:

```http
POST /api/rounds
Authorization: Bearer baijia-local-20260523
```

Export:

```http
GET /api/export
```
