# 百家樂監控數據

全新重做版本。舊版網頁、舊紀錄、舊後端監控、Telegram、Android wrapper、Oracle 部署腳本與舊資料庫流程已從目前 repo 工作樹移除。

## 目前定位

- 純靜態 GitHub Pages PWA。
- 空白資料起點，不讀取舊版 localStorage key 或舊資料庫。
- 手動輸入與批次匯入百家樂結果。
- 顯示珠盤路、大路、統計摘要、資料品質與觀察提醒。
- 支援 JSON / CSV 匯出與 JSON / CSV / TXT 匯入。

本工具只做資料記錄、整理與視覺化，不提供下注建議，不保證任何結果。

## 本機預覽

```powershell
cd C:\Users\Administrator\Baijia
npm test
npm start
```

開啟：

```text
http://localhost:4173
```

## GitHub Pages

Repo：

```text
https://github.com/SYLONG7708/Baijia
```

Pages：

```text
https://sylong7708.github.io/Baijia/
```

GitHub Pages 來源維持 `main` branch root。

## 舊版保留位置

遠端備份分支：

```text
backup/baijia-old-20260622
```

本機 CODEX 備份：

```text
C:\Users\Administrator\Desktop\CODEX 專案資料夾\製作過的 APP 以及資料\Baijia_舊版全新重做前備份_20260622
```
