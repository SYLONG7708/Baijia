# 百家樂監控數據

本專案是全新本機版百家樂路圖記錄與分析工具，定位為合法可見資料的記錄、整理、視覺化與歷史相似度分析。

它不提供自動下注，不保證任何開獎結果，也不會繞過網站驗證、封鎖或平台限制。

## 功能

- 本機 24 小時資料庫：`data/baijia-db.json`
- 目標 ALLBET 36 桌白名單監控，避免分類頁、非目標桌或舊桌污染分析
- 桌台、房間號碼、靴號、每手結果、莊對、閒對、幸運6、卡牌備註記錄
- 珠盤路、大路、大眼仔路、小路、蟑螂路重建
- 輸入現場 8 把以上，回查本機歷史相同路徑與相近路徑
- 珠盤路 / 大路 / 大眼仔 / 小路 / 蟑螂路各自做 6 欄循環分析
- 現場 iPhone 版支援純手動輸入、莊對、閒對、幸運6，以及每一路即時復盤命中率
- 顯示下一把統計偏向、信心分數、樣本數、特殊項出現率
- Collector 會顯示本輪是否正在掃描、掃描開始時間、最後新增局數與 36 桌覆蓋狀態
- Windows 登入自動啟動腳本
- Goodwin/ALLBET 擷取器：背景無視窗讀取 36 桌路單，洗牌中或不可用桌會自動跳過並在健康檢查中註記

## 準確性原則

- 正式 `rounds` 只接受原始結構化結果，例如平台 API/WebSocket 回傳、或人工輸入後由使用者確認的結果。
- 截圖、路圖圖片、OCR、顏色判斷只能當除錯參考，不會寫成正式路單。
- 如果擷取器只看到圖片路圖，會保存為 `output/playwright/` 除錯檔，資料庫只記錄圖片檔路徑與摘要。
- 桌台 key 使用「桌台序號 + 桌名」，避免同名桌台覆蓋。

## 小容量保存格式

正式每手資料只保存必要欄位：

```json
{
  "result": "banker",
  "bankerPair": false,
  "playerPair": true,
  "luckySix": false,
  "bankerPoints": 6,
  "playerPoints": 4,
  "bankerCards": [],
  "playerCards": [],
  "observedAt": "2026-06-23T00:00:00.000Z"
}
```

壓縮本機資料庫、移除測試快照中的大圖文字：

```powershell
npm run data:compact
```

## 本機啟動

```powershell
cd C:\Users\Administrator\Baijia
npm install
npm start
```

開啟：

```text
http://localhost:4173
```

現場 iPhone 版，不讀取歐博資料庫，只用手動輸入分析：

```text
http://localhost:4173/live.html
```

## 公開網路觀看

若要讓 iPhone 或外部網路直接觀看，不需要連同一個 Wi-Fi，可啟動公開 tunnel：

```powershell
cd C:\Users\Administrator\Baijia
npm run public:tunnel
```

系統會產生 `https://*.trycloudflare.com` 公開網址，網址也會保存到：

```text
storage/baijia-public-tunnel.url
```

公開觀看模式只開放儀表板狀態與 8 手分析所需 API；外部訪客不能下載 JSON/CSV、不能新增或清除資料，也看不到本機資料庫路徑。臨時 tunnel 需要本機電腦、背景監控與 `cloudflared` 程序持續執行；若要永久固定網址，需要改用 Cloudflare 帳號與自有網域建立 named tunnel。

公開現場 iPhone 版入口：

```text
https://你的公開網址/live.html
```

## 24 小時常駐

```powershell
cd C:\Users\Administrator\Baijia
npm run daemon
```

常駐模式會同時啟動：

- 本機儀表板：`http://localhost:4173`
- 背景 ALLBET 擷取：預設 `GOODWIN_HEADLESS=true`，不會跳出可見瀏覽器視窗
- 每日資料庫備份：`backups/` 與 CODEX 保存資料夾

安裝 Windows 登入自動啟動：

```powershell
npm run task:install
```

移除自動啟動：

```powershell
npm run task:uninstall
```

手動備份與清理污染桌：

```powershell
npm run backup:db
npm run data:cleanup
```

## Goodwin 擷取設定

複製 `.env.example` 為 `.env.local`，只放在本機，不要上傳 GitHub。

```text
GOODWIN_URL=https://www.goodwin77.com/liveView
GOODWIN_USERNAME=你的帳號
GOODWIN_PASSWORD=你的密碼
GOODWIN_ENABLE_COLLECTOR=true
GOODWIN_HEADLESS=false
COLLECT_INTERVAL_MS=300000
PORT=4173
BAIJIA_HOST=127.0.0.1
BAIJIA_PUBLIC_VIEW=false
```

手動測試擷取器：

```powershell
npm run collector
```

若網站要求驗證碼、2FA、人工安全驗證或阻擋自動化，擷取器會停止並保存截圖到 `output/playwright/`，不會嘗試繞過。

檢查 ALLBET 原始資料流，尋找可 100% 對應路單的 API/WebSocket：

```powershell
npm run network:inspect
```

檢查結果會寫到 `output/network/goodwin-network-candidates.json`，敏感 token 會遮蔽。只有找到可驗證的原始逐手資料後，才應接入正式 `rounds`。

## 測試

```powershell
npm test
```

## 資料與隱私

- `data/`、`logs/`、`storage/`、`.env.local` 已加入 `.gitignore`
- 帳密只允許放在本機 `.env.local`
- 匯出資料可從網頁右上角下載 CSV 或 JSON
