# YouTube 字幕增強器 (YT Subtitle Enhancer)

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/oaklppenkdpldnacibpedgfmaieabnaa?style=for-the-badge&logo=googlechrome&label=Chrome%20Web%20Store)](https://chrome.google.com/webstore/detail/oaklppenkdpldnacibpedgfmaieabnaa)

一個專為 YouTube 外語影片開發的字幕工具，透過 Gemini AI 實現即時、可客製化的雙語字幕翻譯。

本專案採用 **Manifest V3 (MV3) Serverless 架構**。所有翻譯請求均由擴充功能本身 (Service Worker) 直接安全地發送到 Google AI，**無需**依賴任何本地 Python 伺服器。

---

> [!WARNING]
> **重要通知：** 本擴充功能目前**僅支援**將外語翻譯為 **繁體中文 (Traditional Chinese)**。
> 
> **IMPORTANT:** This extension currently **only** supports translation *into* **Traditional Chinese**. It is intended for Traditional Chinese speakers.

---

## 🚀 安裝方式

### 方式一：從 Chrome Web Store 安裝 (建議)

您可以直接從 Chrome Web Store 安裝穩定版本，享受自動更新的便利。

* **[點此前往 Chrome Web Store 進行安裝](https://chrome.google.com/webstore/detail/oaklppenkdpldnacibpedgfmaieabnaa)**

---

### 方式二：手動安裝 (最新功能)

如果您想體驗 GitHub 上的最新功能（或 CWS 尚未通過審核的 Bug 修復），您可以從 [GitHub Releases 頁面](https://github.com/yuforfun/youtube_enhancer/releases) 下載最新的 `.zip` 檔手動載入。

1.  從 GitHub Releases 頁面下載最新的 `YouTube_Subtitle_Extension_vX.X.X.zip`。
2.  將其解壓縮到一個**永久**的資料夾中（請勿刪除此資料夾）。
3.  打開 Chrome/Edge 瀏覽器，進入 `chrome://extensions`。
4.  開啟右上角的「開發人員模式」。
5.  點擊「載入未封裝項目」，並選擇您剛剛解壓縮的**資料夾**。
6.  (重要) 進入擴充功能的「選項」(Options) 頁面，在「Google API 金鑰管理」卡片中新增您自己的 Google Gemini API Key。

---

### ✨ 主要功能

* **高品質 Gemini AI 翻譯**
    採用 100% Serverless 架構，使用您自備的 API 金鑰直接呼叫 Google Gemini API。提供優於 YouTube 原生翻譯的流暢度與準確性。內建穩定性機制，自動切換備用模型，減少翻譯失敗。

* **三層式語言決策 (Tier 1-2-3)**
    您可以完全自訂如何處理不同語言：
    * **Tier 1 (原文顯示)**：您熟悉的語言，強制顯示原文。
    * **Tier 2 (自動翻譯)**：您想學習的語言，自動啟用 AI 翻譯。
    * **Tier 3 (按需翻譯)**：其他語言，預設顯示原文，並提供一個「翻譯」按鈕讓您手動觸發。

* **HQS 引擎 (高品質分句)**
    (實驗性功能) 專為日文 ASR（自動語音辨識）字幕設計。能自動偵測 ASR 的混亂斷句，並將其智慧重組為更易於閱讀的完整句子。

* **金鑰與模型管理**
    * 支援在設定頁面中管理多組 API Key。
    * 支援自訂 Gemini 模型的呼叫優先級（例如：優先使用 `gemini-3.0-flash`）。

* **永久快取 + 管理介面**
    已翻譯的影片會被儲存在瀏覽器本地 (`chrome.storage.local`)，加速二次載入並節省 API 用量。
    設定頁面「診斷與日誌」提供快取清單，可搜尋、預覽縮圖、批次刪除已快取影片。

---

### 📚 完整使用說明 (附圖)

**>> [點此前往 GitHub Wiki 查看完整安裝與使用教學](https://github.com/yuforfun/youtube_enhancer/wiki) <<**

我已將所有詳細的安裝步驟、功能介紹、常見問題與疑難排解，都整理在專案的 Wiki 頁面中。第一次使用的朋友，請務必點擊上方連結查看。


---

### ⚠️ 免責聲明

1.  **[自備金鑰]** 此工具為 100% Serverless，您**必須自行準備**並在「選項」頁面填入您自己的 Google Gemini API Key 才能使用翻譯功能。
2.  **[個人使用]** 此工具僅供個人學習與技術研究使用。所有 API 請求均由使用者自己的金鑰發起，請注意您的用量與費用。

---
### 🙏 致謝

感謝 [**Shison Jun**](https://www.instagram.com/jun_shison0305/p/DOoHP49E-__/) 讓我用愛發電。