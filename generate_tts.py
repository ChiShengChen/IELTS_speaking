#!/usr/bin/env python3
"""
generate_tts.py — 批量將 IELTS 範例答案轉成自然語音 MP3，供反覆聆聽練習。

使用方式:
    pip install edge-tts
    python generate_tts.py              # 產生全部
    python generate_tts.py speaking_p2  # 只產生 Speaking P2
    python generate_tts.py --dry-run    # 預覽不產生檔案

輸出:
    tts_audio/
    ├── speaking_p2/   (英式口音 en-GB-SoniaNeural)
    ├── speaking_p3/   (美式口音 en-US-AvaNeural)
    ├── writing_task1/ (英式口音 en-GB-SoniaNeural)
    └── writing_task2/ (英式口音 en-GB-SoniaNeural)
"""

import asyncio
import re
import sys
from pathlib import Path

import edge_tts

# ─── Configuration ───────────────────────────────────────────────

BASE_DIR = Path(__file__).parent
OUTPUT_DIR = BASE_DIR / "tts_audio"

VOICES = {
    "speaking_p2": "en-GB-SoniaNeural",   # 英式女聲
    "speaking_p3": "en-US-AvaNeural",     # 美式女聲
    "writing_task1": "en-GB-SoniaNeural", # 英式女聲
    "writing_task2": "en-GB-SoniaNeural", # 英式女聲
}

SOURCE_FILES = {
    "speaking_p2": BASE_DIR / "speaking_p2_with_answers.md",
    "speaking_p3": BASE_DIR / "speaking_p3_with_answers.md",
    "writing_task1": BASE_DIR / "writing_task1.md",
    "writing_task2": BASE_DIR / "writing_task2.md",
}

MAX_CONCURRENT = 3  # 同時最多幾條 TTS 請求（避免被限流）
TTS_RATE = "-5%"    # 語速微調，稍慢方便聽清楚（+10% 加快 / -10% 放慢）


# ─── Markdown Parsing ────────────────────────────────────────────

def parse_speaking_qa(md_text: str) -> list[dict]:
    """解析 speaking markdown，格式: # Q1-1: ... # A1-1: ..."""
    pairs = []
    blocks = re.split(r"^(# [QA]\d+-\d+:)", md_text, flags=re.MULTILINE)

    current_q_id = None
    current_q_text = None

    i = 1  # blocks[0] 是第一個 header 前的空白
    while i < len(blocks):
        header = blocks[i].strip()
        content = blocks[i + 1].strip() if i + 1 < len(blocks) else ""
        i += 2

        if header.startswith("# Q"):
            m = re.match(r"# (Q\d+-\d+):", header)
            if m:
                current_q_id = m.group(1)
                current_q_text = content
        elif header.startswith("# A"):
            m = re.match(r"# (A\d+-\d+):", header)
            if m:
                q_num = m.group(1).replace("A", "Q")
                if current_q_id == q_num and current_q_text:
                    pairs.append(
                        {"id": current_q_id, "question": current_q_text, "answer": content}
                    )

    return pairs


def parse_writing_qa(md_text: str, task_type: str) -> list[dict]:
    """解析 writing markdown，格式: # Q1: ... # A1: ..."""
    pairs = []
    blocks = re.split(r"^(# [QA]\d+:)", md_text, flags=re.MULTILINE)

    current_q_id = None
    current_q_text = None

    i = 1
    while i < len(blocks):
        header = blocks[i].strip()
        content = blocks[i + 1].strip() if i + 1 < len(blocks) else ""
        i += 2

        if header.startswith("# Q"):
            m = re.match(r"# (Q\d+):", header)
            if m:
                current_q_id = m.group(1)
                current_q_text = _clean_writing_question(content)
        elif header.startswith("# A"):
            m = re.match(r"# (A\d+):", header)
            if m:
                q_num = m.group(1).replace("A", "Q")
                if current_q_id == q_num and current_q_text:
                    answer = _extract_writing_answer(content, task_type)
                    if answer:
                        pairs.append(
                            {"id": current_q_id, "question": current_q_text, "answer": answer}
                        )

    return pairs


def _clean_writing_question(text: str) -> str:
    """移除標準指令、圖片引用，只保留題目本身。"""
    skip_patterns = [
        re.compile(r"You should spend about \d+ minutes", re.IGNORECASE),
        re.compile(r"Write at least \d+ words", re.IGNORECASE),
        re.compile(r"Summarise the information", re.IGNORECASE),
        re.compile(r"where relevant", re.IGNORECASE),
        re.compile(r"!\[.*?\]\(.*?\)"),
    ]
    lines = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        if any(p.search(line) for p in skip_patterns):
            continue
        lines.append(line)
    return " ".join(lines)


def _extract_writing_answer(text: str, task_type: str) -> str | None:
    """
    Task 1: 直接取 Example answer 全文。
    Task 2: 跳過中文大綱，只取 'Sample Essay (Band 7):' 之後的英文範文。
    """
    if task_type == "writing_task1":
        # 移除 "Example answer：" 前綴
        text = re.sub(r"^Example answers?[：:]\s*", "", text, flags=re.MULTILINE)
        # 移除字數標注 "(223 words)"
        text = re.sub(r"\(\d+ words\)\s*$", "", text.strip())
        return text.strip() or None

    if task_type == "writing_task2":
        # 先找 "Sample Essay (Band N):" 標記
        m = re.search(r"Sample Essay \(Band \d+\):\s*\n(.+)", text, re.DOTALL)
        if m:
            essay = m.group(1).strip()
            essay = re.sub(r"\(\d+ words\)\s*$", "", essay)
            return essay.strip() or None

        # 退而求其次：找 "---" 分隔線之後的內容
        if "---" in text:
            after = text.split("---", 1)[1].strip()
            after = re.sub(r"^Sample Essay.*?:\s*", "", after, flags=re.MULTILINE)
            after = re.sub(r"\(\d+ words\)\s*$", "", after)
            return after.strip() or None

        # 只有中文大綱，無英文範文 → 跳過
        return None

    return None


# ─── TTS Text Assembly ───────────────────────────────────────────

def build_tts_text(question: str, answer: str, category: str) -> str:
    """將題目和答案組成一段自然的 TTS 文稿。"""
    # 題目與答案之間加一個自然停頓
    if category.startswith("speaking"):
        return (
            f"Question.\n{question}\n\n"
            f"Here is the sample answer.\n\n"
            f"{answer}"
        )
    else:
        return (
            f"The question is as follows.\n{question}\n\n"
            f"Here is the sample essay.\n\n"
            f"{answer}"
        )


# ─── TTS Generation ─────────────────────────────────────────────

async def _generate_one(
    sem: asyncio.Semaphore,
    text: str,
    voice: str,
    output_path: Path,
    label: str,
) -> bool:
    async with sem:
        try:
            communicate = edge_tts.Communicate(text, voice, rate=TTS_RATE)
            await communicate.save(str(output_path))
            print(f"  ✓ {label}")
            return True
        except Exception as e:
            print(f"  ✗ {label}: {e}")
            return False


async def process_category(
    category: str,
    pairs: list[dict],
    sem: asyncio.Semaphore,
    dry_run: bool = False,
) -> tuple[int, int]:
    voice = VOICES[category]
    out_dir = OUTPUT_DIR / category
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{'─'*50}")
    print(f"📂 {category}  |  {len(pairs)} 組  |  🔊 {voice}")
    print(f"{'─'*50}")

    if dry_run:
        for p in pairs:
            print(f"  (dry-run) {category}/{p['id']}.mp3")
        return len(pairs), 0

    tasks = []
    for pair in pairs:
        text = build_tts_text(pair["question"], pair["answer"], category)
        out_path = out_dir / f"{pair['id']}.mp3"
        label = f"{category}/{pair['id']}.mp3"
        tasks.append(_generate_one(sem, text, voice, out_path, label))

    results = await asyncio.gather(*tasks)
    ok = sum(1 for r in results if r)
    fail = len(results) - ok
    return ok, fail


# ─── Main ────────────────────────────────────────────────────────

async def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    if dry_run:
        args.remove("--dry-run")

    # 決定要處理哪些分類
    all_categories = ["speaking_p2", "speaking_p3", "writing_task1", "writing_task2"]
    selected = [a for a in args if a in all_categories] or all_categories

    print("🎙️  IELTS TTS Audio Generator")
    print("=" * 50)
    if dry_run:
        print("⚠️  Dry-run mode — 不會產生音檔\n")

    sem = asyncio.Semaphore(MAX_CONCURRENT)
    categories: dict[str, list[dict]] = {}

    # ── 解析各檔案 ──
    for cat in selected:
        md_path = SOURCE_FILES[cat]
        if not md_path.exists():
            print(f"⚠️  {md_path.name} 不存在，跳過")
            continue

        md_text = md_path.read_text(encoding="utf-8")
        if cat.startswith("speaking"):
            pairs = parse_speaking_qa(md_text)
        else:
            pairs = parse_writing_qa(md_text, cat)

        categories[cat] = pairs
        print(f"📄 {cat}: 找到 {len(pairs)} 組 Q/A")

    total = sum(len(p) for p in categories.values())
    print(f"\n🎯 共計 {total} 個音檔待產生")

    # ── 產生 TTS ──
    total_ok, total_fail = 0, 0
    for cat, pairs in categories.items():
        ok, fail = await process_category(cat, pairs, sem, dry_run)
        total_ok += ok
        total_fail += fail

    print(f"\n{'=' * 50}")
    if dry_run:
        print(f"📋 Dry-run 完成，共 {total} 組待產生")
    else:
        print(f"✅ 完成！成功 {total_ok} / 失敗 {total_fail}")
        print(f"📁 音檔位置: {OUTPUT_DIR}/")
    print("=" * 50)


if __name__ == "__main__":
    asyncio.run(main())
