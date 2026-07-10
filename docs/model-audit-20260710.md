# 多專家集成模型稽核 2026-07-10

## 結論

目前沒有任何策略在這批資料上證明可穩定獲利，也沒有方法能保證 5 注內通過。

新的 `onlineEnsemble` 在 36 桌逐局回測中是點估計最佳策略，但平注 ROI 的 95% 下限仍小於 0，因此正式品質閘門維持 `observe`，只輸出每局方向估計，不標示為已證明優勢。

## 回測範圍

- 36/36 桌完成，失敗 0 桌。
- 每桌最近 60 個預測視窗，共 2,160 個視窗。
- `onlineEnsemble` 可比較的非和局：1,978 局。
- 驗證方式：每局先預測、看到結果後才更新的 prequential walk-forward。
- 報表時間：`2026-07-10T14:57:33.409Z`。

## 線上集成結果

| 指標 | 結果 |
|---|---:|
| 非和局命中率 | 50.30% |
| Wilson 95% 下限 | 48.10% |
| 含莊 5% 佣金平注 ROI | +0.26% |
| ROI 95% 下限 | -3.77% |
| Brier score | 0.250124 |
| Brier skill vs 莊方基準 | -0.0148% |
| 5 注完成率 | 97.56% |
| 5 注自然基準 | 96.71% |
| 5 注描述性超額 | +0.85% |

5 注視窗彼此重疊，因此超額只能作風險描述；它不是獨立樣本的顯著性證明，也不是保證。

## 模型配置

- 10 個基礎專家：莊方理論基準、全庫貝葉斯、近期衰減、桌台貝葉斯、1/2/3 階 Markov、連續長度、跳路節奏、牌靴局位。
- 8 個可學習反向專家：除固定莊方與全庫基準外，其他專家各有反向版本。
- 使用 exponential weighting 與 fixed-share，逐局依機率損失自動調整直向/反向權重。
- 近期 Brier 惡化會觸發漂移降權。
- 最終機率會向莊方理論基準收縮，避免小樣本產生極端百分比。
- 正式提醒必須同時通過樣本外 Brier、log-loss、漂移、含佣金保守期望值與 5 注自然基準檢查。

## 驗證

通過：

```powershell
npm test
npm run logic:update
npm run health:runtime
npm run health:data
npm run health:36
npm run health:ui
npm run watch:analysis:once
npm run public:check
```

`npm run health:24h` 因歷史窗內舊缺口失敗；當下 `currentStateHealthy=true`，heartbeat 新鮮，36 桌覆蓋 100%。最早自然通過時間為 `2026-07-11T00:41:54.933Z`。

## 部署邊界

- GitHub 保存原始碼、測試、CI 與本稽核，不上傳帳密、登入 cookie 或原始賭場資料庫。
- 即時 collector 仍依賴這台 Windows 電腦上的登入工作階段與排程；Cloudflare quick tunnel 是公開入口，不是永久雲端主機。
- 工具不控制外部網站、不自動下注、不繞過驗證與平台限制。
