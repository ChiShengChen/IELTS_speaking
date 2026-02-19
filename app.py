import json
import random
import re
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from faster_whisper import WhisperModel

app = FastAPI(title="IELTS Speaking Practice")

BASE_DIR = Path(__file__).parent
RECORDINGS_DIR = BASE_DIR / "recordings"
SESSIONS_DIR = BASE_DIR / "sessions"
QUESTIONS_FILE = BASE_DIR / "questions.json"
DRAWN_P1_FILE = BASE_DIR / "drawn_p1.json"
DRAWN_P2_FILE = BASE_DIR / "drawn_p2.json"

_PART_FILES = {
    "part1": BASE_DIR / "speaking_p1.md",
    "part2": BASE_DIR / "speaking_p2_with_answers.md",
    "part3": BASE_DIR / "speaking_p3_with_answers.md",
}
_DRAWN_FILES = {
    "p1": DRAWN_P1_FILE,
    "p2": DRAWN_P2_FILE,
}

VOCAB_FILE = BASE_DIR / "topic_vocab.json"

RECORDINGS_DIR.mkdir(exist_ok=True)
SESSIONS_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Whisper model (lazy-loaded singleton)
# ---------------------------------------------------------------------------
_whisper_model: WhisperModel | None = None


def _get_model() -> WhisperModel:
    global _whisper_model
    if _whisper_model is None:
        print("⏳ Loading Whisper model (first time, may take a moment)…")
        _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
        print("✅ Whisper model ready")
    return _whisper_model


# ---------------------------------------------------------------------------
# Speech analysis (zero extra dependencies — pure stdlib + regex)
# ---------------------------------------------------------------------------
_FILLERS = {"um", "uh", "er", "ah", "hmm", "like", "basically", "actually", "literally"}
_FILLER_PHRASES = ["you know", "i mean", "kind of", "sort of"]

_DISCOURSE_WORDS = {
    "however", "moreover", "furthermore", "therefore", "consequently",
    "nevertheless", "although", "because", "since", "whereas",
    "besides", "meanwhile", "similarly", "indeed", "certainly",
    "obviously", "clearly", "fortunately", "unfortunately",
    "honestly", "personally", "interestingly", "surprisingly",
}
_DISCOURSE_PHRASES = [
    "in addition", "on the other hand", "as a result", "for example",
    "for instance", "in contrast", "in fact", "as well", "not only",
    "on top of that", "apart from", "in general", "to be honest",
    "in my opinion", "from my perspective",
]

_COMPLEX_MARKERS = {
    "although", "because", "since", "while", "whereas",
    "if", "when", "unless", "whether", "which", "who", "whom",
}


def _analyze(transcript: str, duration: float) -> dict:
    if not transcript or transcript.startswith("(") or duration <= 0:
        return {}

    text = transcript.strip()
    words = text.split()
    wc = len(words)
    if wc == 0:
        return {}

    lower = text.lower()
    tokens = [w.strip(".,!?;:'\"()") for w in lower.split()]
    tokens = [t for t in tokens if t]

    unique = set(tokens)

    filler_count = sum(1 for t in tokens if t in _FILLERS)
    filler_count += sum(lower.count(p) for p in _FILLER_PHRASES)

    sentences = [s.strip() for s in re.split(r"[.!?]+", text) if s.strip()]
    sent_count = max(len(sentences), 1)

    discourse = sum(1 for t in tokens if t in _DISCOURSE_WORDS)
    discourse += sum(1 for p in _DISCOURSE_PHRASES if p in lower)

    complex_count = sum(1 for t in tokens if t in _COMPLEX_MARKERS)

    long_words = [w for w in unique if len(w) >= 7]

    repeated: list[str] = []
    skip = {"very", "really", "so", "that", "the"}
    for i in range(len(tokens) - 1):
        if tokens[i] == tokens[i + 1] and tokens[i] not in skip:
            repeated.append(tokens[i])

    wpm = round((wc / duration) * 60)
    ttr = round(len(unique) / len(tokens), 2)
    avg_word_len = round(sum(len(t) for t in tokens) / len(tokens), 1)

    metrics = {
        "word_count": wc,
        "wpm": wpm,
        "filler_count": filler_count,
        "unique_words": len(unique),
        "vocabulary_diversity": ttr,
        "avg_word_length": avg_word_len,
        "long_word_count": len(long_words),
        "sentence_count": sent_count,
        "avg_sentence_length": round(wc / sent_count, 1),
        "complex_structures": complex_count,
        "discourse_markers": discourse,
        "repeated_words": repeated[:5],
    }
    metrics["band"] = _estimate_band(metrics)
    return metrics


def _lerp(val: float, lo: float, hi: float, out_lo: float = 4.0, out_hi: float = 8.0) -> float:
    if hi == lo:
        return (out_lo + out_hi) / 2
    ratio = (val - lo) / (hi - lo)
    return max(out_lo, min(out_hi, out_lo + ratio * (out_hi - out_lo)))


def _band_round(score: float) -> float:
    return max(4.0, round(score * 2) / 2)


def _estimate_band(m: dict) -> dict:
    """Estimate IELTS Speaking band scores aligned with official descriptors.

    Calibrated conservatively — transcript-based analysis cannot assess actual
    pronunciation or detect grammatical errors, so ceilings are capped:
      FC  max ~7.5  (cannot measure pause/hesitation quality)
      LR  max ~7.5  (cannot verify collocational accuracy)
      GRA max ~7.0  (cannot detect actual grammatical errors)

    Official IELTS Band 7 requires:
      FC:  speaks at length without noticeable effort, uses discourse markers
      LR:  uses less common vocabulary, some awareness of collocation
      GRA: range of complex structures, frequently error-free sentences
    """
    wpm = m["wpm"]
    wc = m["word_count"]

    # ── Fluency & Coherence ──────────────────────────────────────────────
    # Band 7 ≈ 130-160 WPM with natural flow; too fast = rushed/unclear
    if wpm <= 170:
        wpm_s = _lerp(wpm, 70, 170, 4.0, 7.5)
    else:
        wpm_s = _lerp(wpm, 170, 220, 7.5, 5.5)

    # Fillers per minute: Band 7 = rare hesitation (<1/min)
    dur_min = wc / max(wpm, 1)
    fpm = m["filler_count"] / max(dur_min, 0.1)
    filler_s = _lerp(fpm, 8, 0, 3.5, 7.5)

    # Discourse markers: Band 7 needs consistent, appropriate use (6-8+)
    disc_s = _lerp(m["discourse_markers"], 0, 10, 4.0, 7.5)

    fc = _band_round(wpm_s * 0.35 + filler_s * 0.30 + disc_s * 0.35)

    # ── Lexical Resource ─────────────────────────────────────────────────
    # TTR: Band 7 ≈ 0.55-0.65 (less common / idiomatic items expected)
    ttr_s = _lerp(m["vocabulary_diversity"], 0.30, 0.75, 4.0, 7.5)

    # Average word length: longer words signal sophistication
    wl_s = _lerp(m["avg_word_length"], 3.5, 5.5, 4.0, 7.5)

    # Long-word ratio (7+ chars / unique): Band 7 ≈ 20-25%
    unique_count = m.get("unique_words", 1) or 1
    long_ratio = m["long_word_count"] / unique_count
    long_s = _lerp(long_ratio, 0.08, 0.30, 4.0, 7.5)

    lr = _band_round(ttr_s * 0.40 + wl_s * 0.25 + long_s * 0.35)

    # ── Grammatical Range & Accuracy ─────────────────────────────────────
    # Capped at 7.0: transcript analysis cannot detect actual errors
    # Band 7 needs frequent complex structures (8+) with good accuracy
    cx_s = _lerp(m["complex_structures"], 0, 12, 4.0, 7.0)

    # Average sentence length: longer = more subordination / complexity
    sl_s = _lerp(m["avg_sentence_length"], 6, 25, 4.0, 7.0)

    # Repeated consecutive words = self-correction / disfluency
    rep_penalty = min(len(m.get("repeated_words", [])) * 0.5, 1.5)

    gra = _band_round(cx_s * 0.50 + sl_s * 0.50 - rep_penalty)

    overall = _band_round((fc + lr + gra) / 3)

    return {
        "fluency_coherence": fc,
        "lexical_resource": lr,
        "grammatical_range": gra,
        "overall": overall,
    }


def _pronunciation_score(words: list[dict]) -> dict:
    if not words:
        return {"score": 0, "clarity": "N/A", "low_confidence_words": []}

    probs = [w["probability"] for w in words]
    avg_prob = sum(probs) / len(probs)

    LOW_THRESHOLD = 0.5
    low_words = [
        {"word": w["word"], "probability": w["probability"]}
        for w in words if w["probability"] < LOW_THRESHOLD
    ]
    low_words.sort(key=lambda x: x["probability"])

    score = _band_round(_lerp(avg_prob, 0.4, 0.95, 4.0, 8.0))

    if avg_prob >= 0.85:
        clarity = "Clear"
    elif avg_prob >= 0.7:
        clarity = "Mostly clear"
    elif avg_prob >= 0.55:
        clarity = "Some unclear words"
    else:
        clarity = "Needs improvement"

    return {
        "score": score,
        "avg_confidence": round(avg_prob, 3),
        "clarity": clarity,
        "low_confidence_words": low_words[:10],
        "total_words": len(words),
        "unclear_count": len(low_words),
    }


# ---------------------------------------------------------------------------
# API – Transcription
# ---------------------------------------------------------------------------
@app.post("/api/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    session_id: str = Form(...),
    label: str = Form("recording"),
):
    session_dir = RECORDINGS_DIR / session_id
    session_dir.mkdir(exist_ok=True)

    ext = "webm"
    if audio.content_type and "mp4" in audio.content_type:
        ext = "mp4"

    filepath = session_dir / f"{label}.{ext}"
    content = await audio.read()

    if len(content) < 1000:
        return {"transcript": "(No speech detected)", "duration": 0, "analysis": {}}

    filepath.write_bytes(content)

    try:
        model = _get_model()
        segments, info = model.transcribe(
            str(filepath),
            language="en",
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_speech_duration_ms": 500},
            word_timestamps=True,
        )

        all_words = []
        text_parts = []
        for seg in segments:
            text_parts.append(seg.text)
            if seg.words:
                for w in seg.words:
                    all_words.append({
                        "word": w.word.strip(),
                        "probability": round(w.probability, 3),
                        "start": round(w.start, 2),
                        "end": round(w.end, 2),
                    })

        transcript = " ".join(text_parts).strip()
        if not transcript:
            transcript = "(No speech detected)"

        dur = round(info.duration, 1)
        analysis = _analyze(transcript, dur)

        if all_words and analysis:
            analysis["pronunciation"] = _pronunciation_score(all_words)

        return {
            "transcript": transcript,
            "duration": dur,
            "analysis": analysis,
        }
    except Exception as exc:
        return {"transcript": f"(Transcription error: {exc})", "duration": 0, "analysis": {}}


# ---------------------------------------------------------------------------
# API – Question Bank
# ---------------------------------------------------------------------------
def _load_bank() -> dict:
    if QUESTIONS_FILE.exists():
        return json.loads(QUESTIONS_FILE.read_text("utf-8"))
    return {"part1": [], "part2": []}


def _save_bank(data: dict) -> None:
    QUESTIONS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")


@app.get("/api/questions")
async def get_questions():
    return _load_bank()


@app.post("/api/questions")
async def save_questions(request: Request):
    data = await request.json()
    _save_bank(data)
    return {"status": "saved"}


@app.get("/api/questions/random")
async def random_questions(part: str = "part1", count: int = 5):
    bank = _load_bank()
    pool = bank.get(part, [])
    if len(pool) < count:
        raise HTTPException(
            status_code=400,
            detail=f"Not enough questions: have {len(pool)}, need {count}",
        )
    return {"questions": random.sample(pool, count)}


@app.get("/api/load-file")
async def load_file(part: str = "part1"):
    path = _PART_FILES.get(part)
    if not path:
        raise HTTPException(400, f"Unknown part: {part}")
    if not path.exists():
        raise HTTPException(404, f"{path.name} not found")
    return {"content": path.read_text("utf-8")}


# ---------------------------------------------------------------------------
# API – Drawn history (Part 1 & Part 2)
# ---------------------------------------------------------------------------
def _drawn_file(part: str) -> Path:
    return _DRAWN_FILES.get(part, DRAWN_P1_FILE)


def _load_drawn(part: str = "p1") -> list[str]:
    f = _drawn_file(part)
    if f.exists():
        data = json.loads(f.read_text("utf-8"))
        return data.get("drawn_ids", [])
    return []


def _save_drawn(ids: list[str], part: str = "p1") -> None:
    _drawn_file(part).write_text(
        json.dumps({"drawn_ids": ids}, ensure_ascii=False, indent=2), "utf-8"
    )


@app.get("/api/drawn-history")
async def get_drawn_history(part: str = "p1"):
    return {"drawn_ids": _load_drawn(part)}


@app.post("/api/drawn-history")
async def add_drawn_history(request: Request, part: str = "p1"):
    data = await request.json()
    new_ids = data.get("ids", [])
    existing = _load_drawn(part)
    merged = list(dict.fromkeys(existing + new_ids))  # deduplicate, preserve order
    _save_drawn(merged, part)
    return {"drawn_ids": merged}


@app.delete("/api/drawn-history")
async def reset_drawn_history(part: str = "p1"):
    _save_drawn([], part)
    return {"drawn_ids": []}


# ---------------------------------------------------------------------------
# API – Topic Vocabulary
# ---------------------------------------------------------------------------
_vocab_cache: dict = {}


def _load_vocab() -> dict:
    global _vocab_cache
    if _vocab_cache:
        return _vocab_cache
    if VOCAB_FILE.exists():
        _vocab_cache = json.loads(VOCAB_FILE.read_text("utf-8"))
        return _vocab_cache
    return {}


@app.get("/api/vocab")
async def get_vocab(topic: str = ""):
    data = _load_vocab()
    if topic:
        return {"vocab": data.get(topic, [])}
    return {"vocab": {}}


# ---------------------------------------------------------------------------
# API – Sessions
# ---------------------------------------------------------------------------
@app.post("/api/sessions")
async def save_session(request: Request):
    data = await request.json()
    sid = data.get("session_id", uuid.uuid4().hex[:8])
    data["saved_at"] = datetime.now().isoformat()
    (SESSIONS_DIR / f"{sid}.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), "utf-8"
    )
    return {"session_id": sid}


@app.get("/api/sessions")
async def list_sessions(full: bool = False):
    sessions = []
    for f in sorted(SESSIONS_DIR.glob("*.json"), reverse=True):
        d = json.loads(f.read_text("utf-8"))
        if full:
            d["session_id"] = f.stem
            sessions.append(d)
        else:
            sessions.append(
                {
                    "session_id": f.stem,
                    "type": d.get("type"),
                    "created_at": d.get("created_at"),
                    "saved_at": d.get("saved_at"),
                }
            )
    return {"sessions": sessions}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    path = SESSIONS_DIR / f"{session_id}.json"
    if not path.exists():
        raise HTTPException(404, "Session not found")
    d = json.loads(path.read_text("utf-8"))
    d["session_id"] = session_id
    return d


# ---------------------------------------------------------------------------
# API – Stats (streak + weakness tracking)
# ---------------------------------------------------------------------------
_BAND_LABELS = {
    "fluency_coherence": "Fluency & Coherence",
    "lexical_resource": "Lexical Resource",
    "grammatical_range": "Grammatical Range",
}


def _collect_bands(session: dict) -> list[dict]:
    """Extract all band dicts from a session (any type)."""
    bands = []
    stype = session.get("type", "")
    if stype == "part1" and isinstance(session.get("analyses"), list):
        for a in session["analyses"]:
            if isinstance(a, dict) and a.get("band"):
                bands.append(a["band"])
    if stype == "part2" and isinstance(session.get("analysis"), dict):
        b = session["analysis"].get("band")
        if b:
            bands.append(b)
    if stype == "mock":
        for a in (session.get("part1", {}).get("analyses") or []):
            if isinstance(a, dict) and a.get("band"):
                bands.append(a["band"])
        p2a = session.get("part2", {}).get("analysis")
        if isinstance(p2a, dict) and p2a.get("band"):
            bands.append(p2a["band"])
    # part3 (nested under part2 or mock)
    p3 = session.get("part3") or (session.get("part2", {}) if stype != "mock" else session).get("part3")
    if not p3:
        p3 = session.get("part3")
    if isinstance(p3, dict):
        for a in (p3.get("analyses") or []):
            if isinstance(a, dict) and a.get("band"):
                bands.append(a["band"])
    return bands


@app.get("/api/stats")
async def get_stats():
    all_bands: list[dict] = []
    session_dates: list[str] = []

    for f in SESSIONS_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text("utf-8"))
        except Exception:
            continue
        bands = _collect_bands(d)
        all_bands.extend(bands)
        date_str = d.get("created_at") or d.get("saved_at") or ""
        if date_str:
            session_dates.append(date_str[:10])  # YYYY-MM-DD

    # --- Streak ---
    streak = 0
    if session_dates:
        from datetime import date, timedelta
        unique_days = sorted(set(session_dates), reverse=True)
        today = date.today()
        yesterday = today - timedelta(days=1)
        # streak starts from today or yesterday
        if unique_days[0] == str(today) or unique_days[0] == str(yesterday):
            current = datetime.strptime(unique_days[0], "%Y-%m-%d").date()
            streak = 1
            for i in range(1, len(unique_days)):
                prev = datetime.strptime(unique_days[i], "%Y-%m-%d").date()
                if (current - prev).days == 1:
                    streak += 1
                    current = prev
                elif (current - prev).days == 0:
                    continue  # duplicate
                else:
                    break

    # --- Weakness ---
    weakness = None
    if all_bands:
        keys = ["fluency_coherence", "lexical_resource", "grammatical_range"]
        avgs = {}
        for k in keys:
            vals = [b[k] for b in all_bands if k in b and b[k] is not None]
            avgs[k] = round(sum(vals) / len(vals), 2) if vals else None

        valid = {k: v for k, v in avgs.items() if v is not None}
        if valid:
            weakest_key = min(valid, key=valid.get)  # type: ignore[arg-type]
            weakness = {
                "area": weakest_key,
                "label": _BAND_LABELS.get(weakest_key, weakest_key),
                "avg": valid[weakest_key],
                "all_avgs": avgs,
            }

    return {
        "streak": streak,
        "total_sessions": len(list(SESSIONS_DIR.glob("*.json"))),
        "total_analyses": len(all_bands),
        "weakness": weakness,
    }


# ---------------------------------------------------------------------------
# API – PDF Export
# ---------------------------------------------------------------------------
@app.get("/api/sessions/{session_id}/pdf")
async def export_session_pdf(session_id: str):
    path = SESSIONS_DIR / f"{session_id}.json"
    if not path.exists():
        raise HTTPException(404, "Session not found")

    d = json.loads(path.read_text("utf-8"))

    from fpdf import FPDF

    _UNICODE_MAP = str.maketrans({
        "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
        "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00a0": " ",
        "\u200b": "", "\u2002": " ", "\u2003": " ", "\ufeff": "",
    })

    def _safe(text: str) -> str:
        if not text:
            return ""
        text = text.translate(_UNICODE_MAP)
        return text.encode("latin-1", errors="replace").decode("latin-1")

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)

    stype = d.get("type", "unknown")
    title_map = {"part1": "Part 1 Practice", "part2": "Part 2 & 3 Practice", "mock": "Mock Test"}
    pdf.cell(0, 12, _safe(f"IELTS Speaking - {title_map.get(stype, stype.upper())}"), new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "", 10)
    date_str = d.get("created_at", d.get("saved_at", ""))
    if date_str:
        pdf.cell(0, 6, f"Date: {date_str}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    def _add_band_table(band: dict) -> None:
        if not band:
            return
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(0, 6, "Band Scores", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 9)
        labels = [
            ("Overall", band.get("overall")),
            ("FC", band.get("fluency_coherence")),
            ("LR", band.get("lexical_resource")),
            ("GRA", band.get("grammatical_range")),
        ]
        for lbl, val in labels:
            pdf.cell(25, 5, lbl)
            pdf.cell(15, 5, str(val or "-"), new_x="LMARGIN", new_y="NEXT")
        pdf.ln(2)

    def _add_qa(label: str, question: str, transcript: str, analysis: dict, sample: str = "") -> None:
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 7, _safe(label), new_x="LMARGIN", new_y="NEXT")

        pdf.set_font("Helvetica", "B", 9)
        pdf.multi_cell(0, 5, _safe(f"Q: {question}"))
        pdf.ln(1)

        pdf.set_font("Helvetica", "", 9)
        pdf.multi_cell(0, 5, _safe(f"My answer: {transcript}"))
        pdf.ln(1)

        if isinstance(analysis, dict) and analysis.get("band"):
            _add_band_table(analysis["band"])

        if isinstance(analysis, dict) and analysis.get("wpm"):
            pdf.set_font("Helvetica", "", 8)
            metrics_str = (
                f"WPM: {analysis['wpm']} | Words: {analysis.get('word_count', '-')} | "
                f"TTR: {analysis.get('vocabulary_diversity', '-')} | "
                f"Fillers: {analysis.get('filler_count', '-')} | "
                f"Discourse: {analysis.get('discourse_markers', '-')} | "
                f"Complex: {analysis.get('complex_structures', '-')}"
            )
            pdf.multi_cell(0, 4, metrics_str)
            pdf.ln(1)

            pron = analysis.get("pronunciation")
            if pron and pron.get("score"):
                pdf.multi_cell(0, 4, _safe(f"Pronunciation: {pron['clarity']} (score {pron['score']}, avg conf {pron.get('avg_confidence', '-')})"))
                pdf.ln(1)

        if sample:
            pdf.set_font("Helvetica", "I", 8)
            pdf.multi_cell(0, 4, _safe(f"Sample: {sample}"))
            pdf.ln(1)

        pdf.ln(3)

    if stype == "part1":
        questions = d.get("questions", [])
        transcripts = d.get("transcripts", [])
        analyses = d.get("analyses", [])
        samples = d.get("sample_answers", [])
        for i, q in enumerate(questions):
            _add_qa(
                f"Q{i + 1}",
                q,
                transcripts[i] if i < len(transcripts) else "-",
                analyses[i] if i < len(analyses) else {},
                samples[i] if i < len(samples) else "",
            )

    elif stype == "part2":
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 7, "Topic Card", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 9)
        pdf.multi_cell(0, 5, _safe(d.get("topic", "")))
        pdf.ln(2)

        if d.get("notes"):
            pdf.set_font("Helvetica", "I", 9)
            pdf.multi_cell(0, 5, _safe(f"Notes: {d['notes']}"))
            pdf.ln(2)

        _add_qa("Part 2 Response", d.get("topic", ""), d.get("transcript", "-"),
                d.get("analysis", {}), d.get("sample_answer", ""))

        p3 = d.get("part3", {})
        if p3:
            p3_samples = p3.get("sample_answers") or []
            for i, q in enumerate(p3.get("questions", [])):
                _add_qa(
                    f"Part 3 - Q{i + 1}", q,
                    (p3.get("transcripts") or [])[i] if i < len(p3.get("transcripts", [])) else "-",
                    (p3.get("analyses") or [])[i] if i < len(p3.get("analyses", [])) else {},
                    p3_samples[i] if i < len(p3_samples) else "",
                )

    elif stype == "mock":
        p1 = d.get("part1", {})
        for i, q in enumerate(p1.get("questions", [])):
            _add_qa(
                f"Part 1 - Q{i + 1}", q,
                (p1.get("transcripts") or [])[i] if i < len(p1.get("transcripts", [])) else "-",
                (p1.get("analyses") or [])[i] if i < len(p1.get("analyses", [])) else {},
                (p1.get("sample_answers") or [])[i] if i < len(p1.get("sample_answers", [])) else "",
            )

        p2 = d.get("part2", {})
        if p2:
            pdf.set_font("Helvetica", "B", 11)
            pdf.cell(0, 7, "Part 2 Topic", new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Helvetica", "", 9)
            pdf.multi_cell(0, 5, _safe(p2.get("topic", "")))
            pdf.ln(2)

            _add_qa("Part 2 Response", p2.get("topic", ""), p2.get("transcript", "-"),
                    p2.get("analysis", {}), p2.get("sample_answer", ""))

        p3 = d.get("part3", {})
        if p3:
            p3_samples = p3.get("sample_answers") or []
            for i, q in enumerate(p3.get("questions", [])):
                _add_qa(
                    f"Part 3 - Q{i + 1}", q,
                    (p3.get("transcripts") or [])[i] if i < len(p3.get("transcripts", [])) else "-",
                    (p3.get("analyses") or [])[i] if i < len(p3.get("analyses", [])) else {},
                    p3_samples[i] if i < len(p3_samples) else "",
                )

    pdf_path = SESSIONS_DIR / f"{session_id}.pdf"
    pdf.output(str(pdf_path))

    return FileResponse(
        str(pdf_path),
        media_type="application/pdf",
        filename=f"ielts_session_{session_id}.pdf",
    )


# ---------------------------------------------------------------------------
# Serve front-end
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.get("/")
async def root():
    return FileResponse(str(BASE_DIR / "static" / "index.html"))
