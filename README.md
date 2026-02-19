# IELTS Speaking Practice System

這是一個專為 IELTS 口說練習設計的個人 Web 應用程式，整合了錄音、Whisper 語音轉寫與即時語音分析功能。

## 功能

- **Part 1 練習**：貼上 Markdown 格式題目（# Qx-y: / # Ax-y:），每題 45 秒倒數並自動錄音。支援手動輸入或從題庫隨機抽題。
- **Part 2/3 練習**：輸入題目卡內容，提供 2 分鐘筆記時間與 2 分鐘獨白錄音。
- **Whisper ASR**：採用本地 faster-whisper (base 模型) 進行離線轉寫，無需 API key。
- **語音分析**：每段錄音自動計算 WPM、填充詞、詞彙多樣性 (TTR)、篇章標記與複雜句型。
- **結果匯出**：一鍵複製 Markdown 格式結果（含轉寫、範例答案與分析指標），可直接貼入 Claude 或 ChatGPT 進行深度分析。
- **題庫管理**：分開管理 Part 1 與 Part 2 題目，支援隨機抽題。

## 安裝

請確保系統已安裝 Python 3.10+ 與 ffmpeg (macOS 使用者可執行 `brew install ffmpeg`)。

```bash
# 進入專案目錄
cd IELTS_record_ASR

# 建立虛擬環境
python3 -m venv venv

# 啟動虛擬環境
source venv/bin/activate

# 安裝依賴套件
pip install -r requirements.txt
```

*注意：首次執行轉寫時，系統會自動下載 Whisper base 模型（約 150MB）。*

## 啟動

```bash
# 啟動虛擬環境
source venv/bin/activate

# 執行 FastAPI 伺服器
uvicorn app:app --host 127.0.0.1 --port 8000
```

啟動後請開啟瀏覽器訪問：`http://127.0.0.1:8000`

## 使用說明

### Part 1 練習流程

1. 點選 **Part 1 Practice**。
2. 在文字框貼上題目，格式範例如下：
   ```markdown
   # Q1-1:
   How do you usually spend your day at work?
   
   # A1-1:
   Usually, I spend my day at work working diligently...
   
   # Q1-2:
   Do you find it easy to organize your time at work?
   ```
   - `# Qx-y:` 為題目內容。
   - `# Ax-y:` 為範例答案（選填）。
   - `x` 為主題編號，`y` 為該主題下的題號。
3. 下方會即時預覽解析出的題目數量，亦可點選 **Random from Bank** 從題庫隨機抽取 5 題。
4. 點選 **Start Practice** 開始，每題有 45 秒倒數並自動錄音，時間到會自動跳轉下一題。
5. 練習中可按 **Next** 提前跳至下一題。
6. 全部完成後，系統將自動進行轉寫與分析。

### Part 2/3 練習流程

1. 點選 **Part 2 & 3 Practice**。
2. 貼上題目卡內容。
3. 點選 **Start**：進入 2 分鐘筆記時間（可直接在頁面打字），隨後自動切換至 2 分鐘獨白錄音。
4. 錄音結束後自動進行轉寫與分析。

### 結果頁面

- 顯示每題的逐字稿、錄音回放、語音分析指標與範例答案。
- 點選 **Copy for Claude Analysis** 即可複製 Markdown 格式內容，貼進 Claude 取得詳細評分建議。

### 題庫管理

1. 在首頁點選 **Question Bank**。
2. **Part 1**：每一行代表一個題目。
3. **Part 2**：使用 `---` 分隔不同的題目卡。
4. 點選 **Save** 儲存變更。

## 語音分析指標說明

| 指標 | 說明 | 理想範圍 |
| :--- | :--- | :--- |
| Speaking Rate (WPM) | 每分鐘字數 | 110–160 |
| Fillers | 填充詞 (um, uh, like, you know 等) | 越少越好，<2/min |
| Vocab Diversity (TTR) | 類型-詞符比，越高代表用詞越多樣 | ≥ 0.6 |
| Avg Word Length | 平均詞長，越長通常代表用詞越高階 | — |
| Discourse Markers | 篇章標記 (however, in addition 等) | 每段至少 1-2 個 |
| Complex Structures | 複雜句型標記 (although, because, which 等) | 越多代表文法範圍越廣 |
| Repeated Words | 連續重複的詞 | 應為 0 |

## 專案結構

```text
IELTS_record_ASR/
├── app.py              # FastAPI 後端 + Whisper ASR + 語音分析
├── requirements.txt
├── questions.json       # 題庫資料
├── recordings/          # 錄音檔 (按 session 分資料夾)
├── sessions/            # 練習記錄 JSON
└── static/
    ├── index.html       # SPA 主頁面
    ├── css/style.css    # 暗色主題樣式
    └── js/
        ├── app.js       # 主邏輯 + Markdown 解析
        ├── recorder.js  # MediaRecorder 封裝
        └── timer.js     # SVG 圓環計時器
```

## 注意事項

- 本工具僅供個人使用 (localhost)，並非針對生產環境設計。
- 使用時需允許瀏覽器存取麥克風權限。
- 計時器最後 5 秒會播放提示音。
- 錄音檔儲存於 `recordings/` 資料夾，可定期手動清理。
- 若需更精確的轉寫效果，可於 `app.py` 中將模型修改為 `small` 或 `medium`（需消耗更多記憶體）。
