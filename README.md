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
- 百家樂下注提醒工具：手動輸入結果、依歷史資料分析下一注、手動結算勝負與 5 注進度，不自動換桌
- 無洩漏線上多專家集成：10 個基礎專家加上 8 個可學習反向版本；莊方基準、全庫/桌台貝葉斯、近期衰減、1/2/3 階轉移、連續長度、跳路節奏、牌靴局位會逐局自動調整權重與方向
- 牌靴時序修復：沒有靴號時，依時間、局號重置與長時間間隔自動切分牌靴，禁止把跨日同局號串成假規律
- 三層方向分離：路型投票趨勢、AI 最高機率、含莊佣金 EV 較優側各自顯示；未通過驗證的 AI 不得覆蓋五路趨勢
- 樣本外品質閘門：每局必須先預測、看到結果後才能學習，並同時檢查 Brier、log-loss、含 5% 莊佣金的平注 ROI、95% 下限與近期漂移
- 每局可顯示方向估計；只有樣本外機率品質與保守期望值同時通過才會標示「品質通過」
- 顯示下一把統計偏向、信心分數、樣本數、特殊項出現率
- Collector 會顯示本輪是否正在掃描、掃描開始時間、最後新增局數與 36 桌覆蓋狀態
- Windows 登入自動啟動腳本
- Goodwin/ALLBET 擷取器：背景無視窗讀取 36 桌路單，洗牌中或不可用桌會自動跳過並在健康檢查中註記

## 準確性原則

- 正式 `rounds` 只接受原始結構化結果，例如平台 API/WebSocket 回傳、或人工輸入後由使用者確認的結果。
- 截圖、路圖圖片、OCR、顏色判斷只能當除錯參考，不會寫成正式路單。
- 如果擷取器只看到圖片路圖，會保存為 `output/playwright/` 除錯檔，資料庫只記錄圖片檔路徑與摘要。
- 桌台 key 使用「桌台序號 + 桌名」，避免同名桌台覆蓋。
- 「5 注完成率」會和同方向五次內自然出現一次的基準比較。莊方自然基準約 `97.08%`、閒方約 `96.66%`；只有超額與保守超額都為正才可通過，不能把自然機率稱為演算法優勢。
- 回測同時輸出平注 ROI 與 95% 下限。命中率高但含佣金 ROI 未轉正時，正式品質閘門仍會拒絕。
- `npm run health:directions` 會用 12 組相反路型檢查方向是否塌縮成全莊或全閒，並防止低於 50% 的一側被錯標為 AI 最高機率。
- 任何模型都不能保證 5 注內命中或每局獲利；系統的自動切換包含「退回觀察」而不是強行挑一個看似最好的規則。

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

現場 iPhone 版：目前牌路由手動輸入，並使用 36 桌歷史資料做線上集成與品質校準：

```text
http://localhost:4173/live.html
```

五路分析邏輯教學頁，零基礎說明監控版與現場版怎麼計算：

```text
http://localhost:4173/logic.html
```

下注提醒工具：

```text
http://localhost:4173/simulator.html
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

公開分析邏輯教學頁：

```text
https://你的公開網址/logic.html
```

公開下注提醒入口：

```text
https://你的公開網址/simulator.html
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

完整 36 桌逐局回測與最新校準報告：

```powershell
npm run logic:update
```

結果會寫入 `reports/logic-hit-rate-latest.json` 與 `reports/logic-hit-rate-latest.md`。報告中的 5 注視窗彼此可能重疊，只能當風險描述，不能當成獨立樣本或保證。

最新已提交的模型稽核摘要：[`docs/model-audit-20260710.md`](docs/model-audit-20260710.md)。

## 資料與隱私

- `data/`、`logs/`、`storage/`、`.env.local` 已加入 `.gitignore`
- 帳密只允許放在本機 `.env.local`
- 匯出資料可從網頁右上角下載 CSV 或 JSON
