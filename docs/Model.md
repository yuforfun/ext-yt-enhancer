### 1\. 核心：文字生成模型

| 模型名稱 (Model) | 付費版限制 (Paid Limit)<br>RPM / TPM / RPD | 免費版限制 (Free Limit)<br>RPM / TPM / RPD | 備註 |
| :--- | :--- | :--- | :--- |
| **gemini-3-pro** | **25** / 1M / **250** | **免費不可用** | 目前最強模型，但每日僅能呼叫 250 次。代碼名稱：gemini-3-pro-preview |
| **gemini-2.5-pro** | **150** / 2M / **10K** | **免費不可用** | 翻譯主力，付費後每日 1 萬次，非常充足。 |
| **gemini-2.5-flash** | **1K** / 1M / **10K** | **5** / 250K / **20** | 付費版速度極快；免費版一天只能翻 20 次。 |
| **gemini-2.5-flash-lite**| **4K** / 4M / **無限** | **10** / 250K / **20** | 付費版無每日限制；免費版同樣受限 20 次。 |
| **gemini-2.0-flash** | **2K** / 4M / **無限** | **免費不可用** | 上一代 Flash，付費版無每日限制。 |
| **gemini-2.0-flash-lite**| **4K** / 4M / **無限** | **免費不可用** | 上一代 Lite，付費版無每日限制。 |
| **gemini-2.0-flash-exp** | **10** / 250K / **500** | **免費不可用** | 實驗性模型，限制較多。 |

  * **RPM**: 每分鐘請求數 (Requests Per Minute)- 影響「併發速度」。
  * **TPM**: 每分鐘 Token 數 (Tokens Per Minute)
  * **RPD**: 每日請求數 (Requests Per Day)- 影響「能翻譯多長時間影片」。
  * **無限**: 代表該欄位顯示為 "Unlimited"

-----

### 2\. 其他模型：多媒體與特殊用途

這些模型主要用於圖像、語音生成或特定研究，與您的字幕翻譯專案關聯較低。

| 模型分類 | 模型名稱 (Model) | 付費版主要限制 | 一句話備註說明 |
| :--- | :--- | :--- | :--- |
| **多模態 (TTS)** | gemini-2.5-flash-tts | 10 RPM | 文字轉語音模型，用於生成配音，非翻譯用途。 |
| **多模態 (Image)** | gemini-3-pro-image | 20 RPM | 圖像生成模型，用於畫圖，非翻譯用途。 |
| **多模態 (Video)** | veo-3.0 / imagen-4.0 | 極低 (2-10 RPM) | 影片與圖像生成專用模型。 |
| **其他 (開源)** | gemma-3 系列 (1b\~27b) | 30 RPM | Google 的開放權重模型，通常用於地端部署研究，API 版效能不如 Gemini。 |
| **即時 (Live)** | native-audio-dialog | 無限 | 用於即時語音對話 (Live API)，不適合檔案式翻譯。 |
| **預覽/特殊** | deep-research-pro | 每日 1.44K | 深度研究專用模型，針對長文本檢索增強，翻譯用不到。 |



### 錯誤log


violations {

  quota_metric: "generativelanguage.googleapis.com/generate_content_free_tier_input_token_count"

  quota_id: "GenerateContentInputTokensPerModelPerMinute-FreeTier"

  quota_dimensions {

    key: "model"

    value: "gemini-2.5-pro"

  }
  
  
violations {

  quota_metric: "generativelanguage.googleapis.com/generate_content_free_tier_requests"

  quota_id: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"

  quota_dimensions {

    key: "model"

    value: "gemini-2.5-flash"

  }
  
  
violations {

  quota_metric: "generativelanguage.googleapis.com/generate_content_free_tier_requests"

  quota_id: "GenerateRequestsPerDayPerProjectPerModel-FreeTier"

  quota_dimensions {

    key: "model"

    value: "gemini-2.5-flash"

  }

  ### Gemini 模型免費版實測總結 (2026-02-08)

針對當前專案支援的模型，使用免費版 API Key 進行一次性可用性測試，結果如下：

#### 1. 測試結果清單

* **gemini-3-flash-preview**: ✅ **成功** (耗時 3.03s)。輸出格式正確且語意流暢。
* **gemini-2.5-flash**: ✅ **成功** (耗時 4.02s)。翻譯品質穩定，符合台灣口語習慣。
* **gemini-2.5-flash-lite**: ✅ **成功** (耗時 **1.22s**)。回應速度最快，適合效能優先情境。
* **Pro 系列 (3-pro, 2.5-pro)**: ❌ **失敗** (HTTP 429)。免費層級配額限制為 0，無法直接調用。
* **2.0 系列 (2.0-flash, 2.0-flash-lite)**: ❌ **失敗** (HTTP 429)。實測顯示目前免費版 Key 在此等模型上的請求限制亦為 0。

#### 2. 開發與配置建議

* **免費版首選模型**：建議將 `gemini-2.5-flash-lite` 設為預設或高優先級模型，其 1.22s 的響應速度能顯著提升字幕同步的即時感。
* **配額限制說明**：免費版用戶應避開 Pro 系列及 2.0 系列模型，否則將觸發 `RESOURCE_EXHAUSTED` 錯誤導致翻譯中斷。
* **錯誤處理機制**：系統已證實能精確擷取 HTTP 429 錯誤中的 `Quota exceeded` 訊息，未來可持續利用此特性優化斷路器（Circuit Breaker）的判罰邏輯。