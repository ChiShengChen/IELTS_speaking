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
    "part3": BASE_DIR / "speaking_p3.md",
}
_DRAWN_FILES = {
    "p1": DRAWN_P1_FILE,
    "p2": DRAWN_P2_FILE,
}

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
    wpm = m["wpm"]
    if wpm <= 160:
        wpm_s = _lerp(wpm, 60, 150, 4.0, 8.0)
    else:
        wpm_s = _lerp(wpm, 160, 210, 8.0, 5.0)

    dur_min = m["word_count"] / max(wpm, 1)
    fpm = m["filler_count"] / max(dur_min, 0.1)
    filler_s = _lerp(fpm, 6, 0, 4.0, 8.0)

    disc_s = _lerp(m["discourse_markers"], 0, 4, 5.0, 8.0)

    fc = _band_round(wpm_s * 0.4 + filler_s * 0.35 + disc_s * 0.25)

    ttr_s = _lerp(m["vocabulary_diversity"], 0.30, 0.70, 4.0, 8.0)
    wl_s = _lerp(m["avg_word_length"], 3.0, 5.0, 4.0, 8.0)
    long_s = _lerp(m["long_word_count"], 0, 8, 4.5, 8.0)
    lr = _band_round(ttr_s * 0.45 + wl_s * 0.25 + long_s * 0.30)

    cx_s = _lerp(m["complex_structures"], 0, 5, 5.0, 8.0)
    sl_s = _lerp(m["avg_sentence_length"], 5, 20, 4.0, 8.0)
    rep_penalty = len(m.get("repeated_words", [])) * 0.5
    gra = _band_round(cx_s * 0.55 + sl_s * 0.45 - rep_penalty)

    overall = _band_round((fc + lr + gra) / 3)

    return {
        "fluency_coherence": fc,
        "lexical_resource": lr,
        "grammatical_range": gra,
        "overall": overall,
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
        )
        transcript = " ".join(seg.text for seg in segments).strip()
        if not transcript:
            transcript = "(No speech detected)"

        dur = round(info.duration, 1)
        return {
            "transcript": transcript,
            "duration": dur,
            "analysis": _analyze(transcript, dur),
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
async def list_sessions():
    sessions = []
    for f in sorted(SESSIONS_DIR.glob("*.json"), reverse=True):
        d = json.loads(f.read_text("utf-8"))
        sessions.append(
            {
                "session_id": f.stem,
                "type": d.get("type"),
                "created_at": d.get("created_at"),
                "saved_at": d.get("saved_at"),
            }
        )
    return {"sessions": sessions}


# ---------------------------------------------------------------------------
# Serve front-end
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.get("/")
async def root():
    return FileResponse(str(BASE_DIR / "static" / "index.html"))
