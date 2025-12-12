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