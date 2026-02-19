# IELTS Speaking Practice System

這是一個專為 IELTS 口說練習設計的個人 Web 應用程式，整合了錄音、Whisper 語音轉寫、即時語音分析與 IELTS 分數估算功能。

## 功能

- **Part 1 練習**：自動從 `speaking_p1.md` 載入題目，隨機抽取 5 題未練習過的題目，每題 45 秒倒數並自動錄音。支援手動輸入或從題庫隨機抽題。
- **Part 2/3 練習**：自動從 `speaking_p2_with_answers.md` 載入題目卡，隨機抽取 1 張未練習過的題目卡，提供 2 分鐘筆記時間與 2 分鐘獨白錄音。
- **已抽題追蹤**：Part 1 與 Part 2 分別記錄已練習過的題目（`drawn_p1.json` / `drawn_p2.json`），避免重複抽取。全部練完可重置。
- **Whisper ASR**：採用本地 faster-whisper (base 模型) 進行離線轉寫，無需 API key。
- **語音分析**：每段錄音自動計算 WPM、填充詞、詞彙多樣性 (TTR)、篇章標記與複雜句型。
- **IELTS 分數估算**：根據轉寫文本自動估算 Fluency & Coherence、Lexical Resource、Grammatical Range 與 Overall Band Score。
- **範例答案對照**：Part 1 與 Part 2 結果頁面皆顯示範例答案，方便與自己的回答進行比較。
- **結果匯出**：一鍵複製 Markdown 格式結果（含轉寫、範例答案、分析指標與分數估算），可直接貼入 Claude 或 ChatGPT 進行深度分析。
- **完整模擬測驗 (Mock Test)**：一鍵啟動 Part 1 → Part 2 → Part 3 連續模擬測驗，自動抽題、計時、錄音，結束後顯示所有部分的綜合成績。
- **練習歷史儀表板**：查看所有過往練習紀錄，包含各項 Band Score 與 SVG 趨勢圖（FC / LR / GRA / Overall 隨時間變化）。
- **轉寫文本高亮標記**：結果頁面的逐字稿自動以顏色標示語言品質：<span style="color:red">紅色</span>=填充詞 (fillers)、<span style="color:green">綠色</span>=篇章標記 (discourse markers)、<span style="color:blue">藍色</span>=複雜句型 (complex structures)。
- **弱項追蹤與練習 Streak**：首頁顯示連續練習天數 (🔥 streak) 及最弱評分項目提醒，幫助針對性加強。
- **發音初步評估**：利用 Whisper word-level timestamps 與 confidence scores，計算發音清晰度分數並標記低信心度詞彙。
- **Part 2 要點覆蓋檢查**：自動解析題目卡 "You should say" 的 bullet points，檢查逐字稿是否涵蓋每個要點（✅ / ❌）。
- **主題詞彙建議**：Part 2 筆記階段顯示該主題 10-15 個 Band 7+ 高分詞彙建議（`topic_vocab.json`），結果頁面標示實際使用了哪些。
- **PDF 匯出**：一鍵下載練習紀錄 PDF 報告（含題目、逐字稿、分析指標、Band Score），方便分享給老師。
- **題庫管理**：分開管理 Part 1 與 Part 2 題目，支援隨機抽題。

## 題庫內容

| 檔案 | 說明 | 數量 |
| :--- | :--- | :--- |
| `speaking_p1.md` | Part 1 題目與範例答案 | 31 個主題，約 120+ 題 |
| `speaking_p2.md` | Part 2 題目卡（純題目） | 51 張題目卡 |
| `speaking_p2_with_answers.md` | Part 2 題目卡 + Band 7 範例答案 | 51 組 Q/A |
| `speaking_p3.md` | Part 3 討論題（每張 Part 2 題目卡對應 3 題） | 153 題 |
| `topic_vocab.json` | 主題詞彙建議（Band 7+ 高分詞彙） | 51 個主題 × 10-15 詞 |
| `speaking_p2p3_data/` | Part 2 原始題目與套題策略檔 | 來源資料 |

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
2. 系統自動從 `speaking_p1.md` 載入題目，隨機抽取 5 題尚未練習過的題目。
3. 若不滿意當前抽題，可點選 **Reshuffle** 重新抽取。
4. 亦可手動貼上題目，格式範例如下：
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
5. 點選 **Start Practice** 開始，每題有 45 秒倒數並自動錄音，時間到會自動跳轉下一題。
6. 練習中可按 **Next** 提前跳至下一題。
7. 全部完成後，系統將自動進行轉寫與分析，並將已抽題目記錄至 `drawn_p1.json`。
8. 當所有題目皆已練習過，系統會提示並提供 **Reset History** 按鈕重置紀錄。

### Part 2 & 3 練習流程

完整模擬真實 IELTS 口說 Part 2 → Part 3 連續流程：

1. 點選 **Part 2 & 3 Practice**。
2. 系統自動從 `speaking_p2_with_answers.md` 載入題目卡，隨機抽取 1 張尚未練習過的題目卡。
3. 若不滿意當前題目，可點選 **Reshuffle** 重新抽取。亦可手動貼上題目卡內容。
4. 點選 **Start**：進入 **2 分鐘筆記時間**（可直接在頁面打字），隨後自動切換至 **2 分鐘獨白錄音**（Part 2）。
5. Part 2 錄音結束後，系統自動載入該題目對應的 **3 題 Part 3 討論題**（from `speaking_p3.md`），每題 **60 秒**倒數並自動錄音。可按 **Next** 提前跳至下一題。
6. Part 3 完成後，系統將 Part 2 與 Part 3 所有錄音**平行轉寫**，並將已抽題目記錄至 `drawn_p2.json`。
7. 當所有題目卡皆已練習過，系統會提示並提供 **Reset History** 按鈕重置紀錄。

> 若手動輸入題目卡（非從檔案載入），Part 3 將自動跳過，僅進行 Part 2 練習。

### 完整模擬測驗 (Mock Test)

模擬真實 IELTS 口說測驗的完整流程（約 11–14 分鐘）：

1. 點選 **Mock Test**。
2. 系統自動從題庫抽取 Part 1（5 題）與 Part 2（1 張題目卡），優先選取未練習過的題目。
3. 開始後依序進行：
   - **Part 1**：5 題，每題 45 秒。
   - **Part 2**：2 分鐘筆記 + 2 分鐘獨白。
   - **Part 3**：3 題討論題，每題 60 秒。
4. 全程不中斷，各階段自動銜接。
5. 結束後顯示 **Mock Test Results**，包含所有 Part 的逐字稿、分析與分數。
6. 匯出 Markdown 時會標示為完整模擬測驗格式。

### 結果頁面

- 顯示各 Part 回答，每段皆含逐字稿（含高亮標記）、錄音回放、語音分析指標與 IELTS 分數估算。
- 逐字稿自動高亮：紅色=填充詞、綠色=篇章標記、藍色=複雜句型。
- **發音評估**：顯示 Whisper 信心度分數、清晰度等級，以及低信心度詞彙清單。
- **Part 2 要點覆蓋**：自動檢查回答是否涵蓋題目卡的每個 bullet point（✅ 已覆蓋 / ❌ 遺漏）。
- **詞彙使用**：標示 Part 2 回答中實際使用了哪些建議高分詞彙（綠色=使用、灰色=未使用）。
- 點選 **Copy for Claude Analysis** 即可複製完整 Markdown 格式內容，貼進 Claude 取得詳細評分建議。
- 點選 **Download PDF** 即可下載該次練習的 PDF 報告。

### 首頁統計

- **練習 Streak**：首頁顯示連續練習天數（🔥 N days），鼓勵每日練習。
- **弱項提醒**：系統自動計算歷次練習中 FC / LR / GRA 的平均分數，在首頁標示最弱項目及其平均分數，方便針對性加強。

### 練習歷史

1. 在首頁點選 **Practice History**。
2. 若有 2 筆以上練習紀錄，頂部會顯示 Band Score 趨勢圖（FC / LR / GRA / Overall）。
3. 下方列出所有練習紀錄，包含日期、類型與各項 Band Score。

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
| Pronunciation Clarity | Whisper 信心度（越高代表發音越清楚） | avg ≥ 85% |
| Unclear Words | 信心度低於 50% 的詞彙 | 越少越好 |

## IELTS 分數估算說明

系統根據轉寫文本自動估算以下四項分數（4.0–8.0，以 0.5 為級距）：

| 項目 | 評估依據 |
| :--- | :--- |
| Fluency & Coherence (FC) | 語速 (WPM)、填充詞頻率、篇章標記使用量 |
| Lexical Resource (LR) | 詞彙多樣性 (TTR)、平均詞長、長詞數量 |
| Grammatical Range (GRA) | 複雜句型標記數、平均句長、重複詞扣分 |
| Overall | 三項平均，四捨五入至 0.5 |

*注意：FC / LR / GRA 為基於轉寫文本的估算；發音分數另由 Whisper confidence scores 獨立評估。*

## 轉寫高亮標記說明

結果頁面的逐字稿會自動以顏色標示以下三類詞彙：

| 顏色 | 類別 | 範例 |
| :--- | :--- | :--- |
| 🔴 紅色 | 填充詞 (Fillers) | um, uh, like, basically, you know, I mean, kind of |
| 🟢 綠色 | 篇章標記 (Discourse Markers) | however, moreover, in addition, on the other hand |
| 🔵 藍色 | 複雜句型 (Complex Structures) | although, because, while, which, who, unless |

若某詞同時屬於篇章標記與複雜句型（如 although, because），優先以藍色（複雜句型）標示。

## 專案結構

```text
IELTS_record_ASR/
├── app.py                          # FastAPI 後端 + Whisper ASR + 語音分析 + 分數估算 + PDF 匯出
├── requirements.txt
├── README.md
├── topic_vocab.json                # 主題詞彙建議（51 主題 × 10-15 Band 7+ 詞彙）
├── speaking_p1.md                  # Part 1 題目與範例答案
├── speaking_p2.md                  # Part 2 題目卡（純題目）
├── speaking_p2_with_answers.md     # Part 2 題目卡 + Band 7 範例答案
├── speaking_p3.md                  # Part 3 討論題（每張 Part 2 卡對應 3 題）
├── speaking_p2p3_data/             # Part 2 原始題目與套題策略
│   ├── speaking_p2_q.md
│   └── speaking_p2_core.md
├── questions.json                  # 題庫資料
├── drawn_p1.json                   # Part 1 已抽題紀錄
├── drawn_p2.json                   # Part 2 已抽題紀錄
├── recordings/                     # 錄音檔（按 session 分資料夾）
├── sessions/                       # 練習記錄 JSON（含轉寫、分析、分數）
└── static/
    ├── index.html                  # SPA 主頁面
    ├── css/style.css               # 暗色主題樣式
    └── js/
        ├── app.js                  # 主邏輯 + Markdown 解析 + 題目自動載入
        ├── recorder.js             # MediaRecorder 封裝
        └── timer.js                # SVG 圓環計時器
```

## 注意事項

- 本工具僅供個人使用 (localhost)，並非針對生產環境設計。
- 使用時需允許瀏覽器存取麥克風權限。
- 計時器最後 5 秒會播放提示音。
- 錄音檔儲存於 `recordings/` 資料夾，可定期手動清理。
- 若需更精確的轉寫效果，可於 `app.py` 中將模型修改為 `small` 或 `medium`（需消耗更多記憶體）。
