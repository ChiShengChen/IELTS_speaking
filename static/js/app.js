/* ===========================================================
   IELTS Speaking Practice — Main Application
   =========================================================== */

import { Timer, playBeep } from './timer.js';
import { AudioRecorder, transcribeBlob } from './recorder.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  sessionId: null,
  recorder: new AudioRecorder(),
  mockMode: false,

  part1Parsed: [],
  part1Questions: [],
  part1Answers: [],
  part1Index: 0,
  part1Recordings: [],
  part1Transcripts: [],
  part1Timer: null,

  part2Topic: '',
  part2Notes: '',
  part2Recording: null,
  part2Transcript: null,
  part2NotesTimer: null,
  part2SpeakTimer: null,

  part3Parsed: [],
  part3Questions: [],
  part3Index: 0,
  part3Recordings: [],
  part3Transcripts: [],
  part3Timer: null,
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  const target = $(`#screen-${id}`);
  if (target) target.classList.add('active');
}

function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

let _readingTimer = null;

function readingCountdown(textEl, ringEl, badgeEl, seconds = 5) {
  return new Promise((resolve) => {
    let remaining = seconds;
    const circumference = 2 * Math.PI * 52;
    ringEl.style.strokeDasharray = circumference;
    ringEl.style.strokeDashoffset = 0;
    ringEl.classList.remove('warning', 'danger');
    textEl.textContent = remaining;

    if (badgeEl) {
      badgeEl.classList.add('active', 'reading');
      badgeEl.querySelector('.rec-label').textContent = 'Read the question';
    }

    _readingTimer = {
      id: setInterval(() => {
        remaining--;
        textEl.textContent = remaining > 0 ? remaining : '';
        const fraction = 1 - remaining / seconds;
        ringEl.style.strokeDashoffset = circumference * fraction;

        if (remaining <= 0) {
          clearInterval(_readingTimer.id);
          _readingTimer = null;
          if (badgeEl) badgeEl.classList.remove('reading');
          playBeep(800, 200);
          resolve(true);
        }
      }, 1000),
      resolve,
    };
  });
}

function cancelReadingCountdown() {
  if (_readingTimer) {
    clearInterval(_readingTimer.id);
    const { resolve } = _readingTimer;
    _readingTimer = null;
    resolve(false);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Routing — event delegation
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const handlers = {
    'goto-home':        () => { loadHomeStats(); showScreen('home'); },
    'goto-part1-setup': () => { showScreen('part1-setup'); autoLoadFile(); },
    'goto-part2-setup': () => { showScreen('part2-setup'); autoLoadFilePart2(); },
    'goto-bank':        () => { loadBank(); showScreen('bank'); },
    'goto-history':     () => { loadHistory(); showScreen('history'); },
    'start-mock-test':  startMockTest,
    'load-file-part1':  loadFilePart1,
    'random-part1':     randomPart1,
    'start-part1':      startPart1,
    'skip-part1':       () => advancePart1(),
    'random-part2':     randomPart2,
    'start-part2':      startPart2,
    'skip-part3':       () => advancePart3(),
    'copy-results':     copyResults,
    'download-pdf':     downloadPdf,
    'save-bank':        saveBank,
    'reset-drawn':      resetDrawnHistory,
    'set-p1-mode-topic': () => setP1DrawMode('topic'),
    'set-p1-mode-random': () => setP1DrawMode('random'),
    'reshuffle-part1':  loadFilePart1,
    'reset-drawn-part2':  resetDrawnHistoryPart2,
    'reshuffle-part2':    loadFilePart2,
    'view-session':       () => { viewSessionDetail(btn.dataset.sessionId); },
    'back-to-history':    loadHistory,
    'download-session-pdf': () => { window.open(`/api/sessions/${btn.dataset.sessionId}/pdf`); },
    'copy-history-detail': copyHistoryDetail,
  };

  if (handlers[action]) handlers[action]();
});

// ---------------------------------------------------------------------------
// Markdown parser — extracts Q/A pairs from # Qx-y: / # Ax-y: format
// ---------------------------------------------------------------------------
function parseQuestionsMarkdown(text) {
  const results = [];
  const headerRe = /^#\s*([QA])(\d+-\d+)\s*:?\s*$/;
  const lines = text.split('\n');

  let current = null;
  let contentLines = [];

  function flush() {
    if (!current) return;
    const body = contentLines.join('\n').trim();
    if (current.type === 'Q') {
      results.push({ id: current.id, question: body, answer: '' });
    } else if (current.type === 'A') {
      const match = results.findLast((r) => r.id === current.id);
      if (match) match.answer = body;
    }
  }

  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      flush();
      current = { type: m[1], id: m[2] };
      contentLines = [];
    } else {
      contentLines.push(line);
    }
  }
  flush();

  return results.filter((r) => r.question);
}

function renderParsedPreview(parsed, drawnInfo) {
  const el = $('#part1-parsed-preview');
  if (!parsed.length) {
    el.innerHTML = '';
    return;
  }
  const withAnswer = parsed.filter((p) => p.answer).length;
  let summaryExtra = withAnswer ? ` · ${withAnswer} with sample answers` : '';
  if (drawnInfo) {
    const unit = drawnInfo.unit || 'questions';
    summaryExtra += ` · <span class="drawn-status">${drawnInfo.remaining} ${unit} remaining / ${drawnInfo.total} total</span>`;
  }
  el.innerHTML =
    `<div class="parsed-summary">${parsed.length} questions selected${summaryExtra}</div>` +
    parsed
      .map(
        (p) =>
          `<div class="parsed-item">` +
          `<span class="parsed-id">Q${p.id}</span>` +
          `<span class="parsed-q">${escapeHtml(p.question)}</span>` +
          (p.answer ? `<span class="parsed-has-answer">has answer</span>` : '') +
          `</div>`,
      )
      .join('');
}

// Live preview as user types / pastes
document.addEventListener('DOMContentLoaded', () => {
  const input = $('#part1-md-input');
  if (input) {
    const update = () => renderParsedPreview(parseQuestionsMarkdown(input.value));
    input.addEventListener('input', update);
    input.addEventListener('paste', () => setTimeout(update, 0));
  }
});

// ---------------------------------------------------------------------------
// Part 1 — Setup
// ---------------------------------------------------------------------------
let _fileAnswers = {};
let _allFileParsed = [];  // all questions from the file (for drawn tracking)
let _p1DrawMode = 'topic';  // 'topic' = one full Qx-* group | 'random' = random 5

function setP1DrawMode(mode) {
  _p1DrawMode = mode;
  const btnTopic = $('#btn-mode-topic');
  const btnRandom = $('#btn-mode-random');
  if (btnTopic) btnTopic.classList.toggle('active', mode === 'topic');
  if (btnRandom) btnRandom.classList.toggle('active', mode === 'random');
  loadFilePart1();
}

function _groupByTopic(parsed) {
  const groups = {};
  for (const p of parsed) {
    const topic = p.id.split('-')[0];
    if (!groups[topic]) groups[topic] = [];
    groups[topic].push(p);
  }
  return groups;
}

// Part 2 file-loaded state
let _fileAnswersPart2 = {};
let _fileAnswersPart3 = {};
let _allFileParsedPart2 = [];
let _currentPart2Id = null;
let _part3AllParsed = [];

async function autoLoadFile() {
  if ($('#part1-md-input').value.trim()) return;
  await loadFilePart1();
}

function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadFilePart1() {
  try {
    const res = await fetch('/api/load-file?part=part1');
    if (!res.ok) return;
    const { content } = await res.json();
    const parsed = parseQuestionsMarkdown(content);

    _fileAnswers = {};
    _allFileParsed = parsed;
    parsed.forEach((p) => { if (p.answer) _fileAnswers[p.id] = p.answer; });

    let drawnIds = [];
    try {
      const dRes = await fetch('/api/drawn-history?part=p1');
      if (dRes.ok) {
        const dData = await dRes.json();
        drawnIds = dData.drawn_ids || [];
      }
    } catch { /* ignore */ }

    const drawnSet = new Set(drawnIds);
    let selected;

    if (_p1DrawMode === 'topic') {
      const groups = _groupByTopic(parsed);
      const topicNums = Object.keys(groups);
      const drawnTopics = new Set(drawnIds.filter((id) => id.startsWith('topic-')).map((id) => id.replace('topic-', '')));
      let undrawnTopics = topicNums.filter((t) => !drawnTopics.has(t));
      if (undrawnTopics.length === 0 && topicNums.length > 0) {
        _showAllDrawnStatus(topicNums.length, 'topics');
        undrawnTopics = topicNums;
      }
      const chosenTopic = _shuffle(undrawnTopics)[0];
      selected = chosenTopic ? groups[chosenTopic] : [];
    } else {
      let undrawn = parsed.filter((p) => !drawnSet.has(p.id));
      if (undrawn.length === 0 && parsed.length > 0) {
        _showAllDrawnStatus(parsed.length, 'questions');
        undrawn = parsed;
      }
      selected = _shuffle(undrawn).slice(0, 5);
    }

    const questionsOnly = selected
      .map((p) => `# Q${p.id}:\n${p.question}`)
      .join('\n\n');
    $('#part1-md-input').value = questionsOnly;

    const drawnInfo = _p1DrawMode === 'topic'
      ? { remaining: _countUndrawnTopics(parsed, drawnIds), total: Object.keys(_groupByTopic(parsed)).length, unit: 'topics' }
      : { remaining: parsed.filter((p) => !drawnSet.has(p.id)).length, total: parsed.length, unit: 'questions' };
    renderParsedPreview(parseQuestionsMarkdown(questionsOnly), drawnInfo);
  } catch {
    // file not found — silent
  }
}

function _countUndrawnTopics(parsed, drawnIds) {
  const allTopics = Object.keys(_groupByTopic(parsed));
  const drawnTopics = new Set(drawnIds.filter((id) => id.startsWith('topic-')).map((id) => id.replace('topic-', '')));
  return allTopics.filter((t) => !drawnTopics.has(t)).length;
}

function _showAllDrawnStatus(total, unit = 'questions') {
  const el = $('#part1-drawn-status');
  if (!el) return;
  el.innerHTML =
    `<div class="drawn-all-done">All ${total} ${unit} have been practiced! ` +
    `<button class="btn btn-ghost btn-small" data-action="reset-drawn">Reset History</button></div>`;
}

async function resetDrawnHistory() {
  try {
    await fetch('/api/drawn-history?part=p1', { method: 'DELETE' });
    const el = $('#part1-drawn-status');
    if (el) el.innerHTML = '';
    await loadFilePart1();
  } catch { /* ignore */ }
}

async function markDrawn(ids, part = 'p1') {
  try {
    await fetch(`/api/drawn-history?part=${part}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Part 2 — Setup (auto-load from speaking_p2_with_answers.md)
// ---------------------------------------------------------------------------
async function autoLoadFilePart2() {
  preloadPart3();
  if ($('#part2-topic-input').value.trim()) return;
  await loadFilePart2();
}

async function preloadPart3() {
  try {
    const res = await fetch('/api/load-file?part=part3');
    if (!res.ok) return;
    const { content } = await res.json();
    _part3AllParsed = parseQuestionsMarkdown(content);
    _fileAnswersPart3 = {};
    _part3AllParsed.forEach((p) => {
      if (p.answer) _fileAnswersPart3[p.id] = p.answer;
    });
  } catch { /* ignore */ }
}

async function loadFilePart2() {
  try {
    const res = await fetch('/api/load-file?part=part2');
    if (!res.ok) return;
    const { content } = await res.json();
    const parsed = parseQuestionsMarkdown(content);

    _fileAnswersPart2 = {};
    _allFileParsedPart2 = parsed;
    parsed.forEach((p) => { if (p.answer) _fileAnswersPart2[p.id] = p.answer; });

    let drawnIds = [];
    try {
      const dRes = await fetch('/api/drawn-history?part=p2');
      if (dRes.ok) {
        const dData = await dRes.json();
        drawnIds = dData.drawn_ids || [];
      }
    } catch { /* ignore */ }

    const drawnSet = new Set(drawnIds);
    let undrawn = parsed.filter((p) => !drawnSet.has(p.id));

    if (undrawn.length === 0 && parsed.length > 0) {
      _showAllDrawnStatusPart2(parsed.length);
      undrawn = parsed;
    }

    const selected = _shuffle(undrawn)[0];
    if (!selected) return;

    _currentPart2Id = selected.id;
    $('#part2-topic-input').value = selected.question;

    const remaining = parsed.filter((p) => !drawnSet.has(p.id)).length;
    _renderPart2Preview(selected, { remaining, total: parsed.length });
  } catch {
    // file not found — silent
  }
}

function _renderPart2Preview(card, drawnInfo) {
  const el = $('#part2-parsed-preview');
  if (!el) return;
  if (!card) { el.innerHTML = ''; return; }
  let html = `<div class="parsed-summary">Topic Q${card.id}`;
  if (card.answer) html += ' · has sample answer';
  if (drawnInfo) html += ` · <span class="drawn-status">${drawnInfo.remaining} remaining / ${drawnInfo.total} total</span>`;
  html += '</div>';
  el.innerHTML = html;
}

function _showAllDrawnStatusPart2(total) {
  const el = $('#part2-drawn-status');
  if (!el) return;
  el.innerHTML =
    `<div class="drawn-all-done">All ${total} topics have been practiced! ` +
    `<button class="btn btn-ghost btn-small" data-action="reset-drawn-part2">Reset History</button></div>`;
}

async function resetDrawnHistoryPart2() {
  try {
    await fetch('/api/drawn-history?part=p2', { method: 'DELETE' });
    const el = $('#part2-drawn-status');
    if (el) el.innerHTML = '';
    await loadFilePart2();
  } catch { /* ignore */ }
}

async function markDrawnPart2(ids) {
  try {
    await fetch('/api/drawn-history?part=p2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  } catch { /* ignore */ }
}

async function randomPart1() {
  try {
    const res = await fetch('/api/questions/random?part=part1&count=5');
    if (!res.ok) {
      const err = await res.json();
      alert(err.detail || 'Not enough questions in bank');
      return;
    }
    const { questions } = await res.json();
    const md = questions
      .map((q, i) => `# Q0-${i + 1}:\n${q}`)
      .join('\n\n');
    $('#part1-md-input').value = md;
    renderParsedPreview(parseQuestionsMarkdown(md));
  } catch {
    alert('Failed to load questions. Is the question bank populated?');
  }
}

// ---------------------------------------------------------------------------
// Mock Test — Full simulation (Part 1 → 2 → 3)
// ---------------------------------------------------------------------------
async function startMockTest() {
  state.mockMode = true;
  state.sessionId = generateSessionId();

  state.part1Parsed = [];
  state.part1Questions = [];
  state.part1Answers = [];
  state.part1Recordings = [];
  state.part1Transcripts = [];
  state.part2Topic = '';
  state.part2Notes = '';
  state.part2Recording = null;
  state.part2Transcript = null;
  state.part3Parsed = [];
  state.part3Questions = [];
  state.part3Recordings = [];
  state.part3Transcripts = [];

  try {
    const [p1Res, p2Res, p3Res] = await Promise.all([
      fetch('/api/load-file?part=part1').then((r) => r.ok ? r.json() : null),
      fetch('/api/load-file?part=part2').then((r) => r.ok ? r.json() : null),
      fetch('/api/load-file?part=part3').then((r) => r.ok ? r.json() : null),
    ]);

    if (!p1Res?.content || !p2Res?.content) {
      alert('Mock test requires speaking_p1.md and speaking_p2_with_answers.md files.');
      state.mockMode = false;
      return;
    }

    const p1All = parseQuestionsMarkdown(p1Res.content);
    _fileAnswers = {};
    _allFileParsed = p1All;
    p1All.forEach((p) => { if (p.answer) _fileAnswers[p.id] = p.answer; });

    const p2All = parseQuestionsMarkdown(p2Res.content);
    _fileAnswersPart2 = {};
    _allFileParsedPart2 = p2All;
    p2All.forEach((p) => { if (p.answer) _fileAnswersPart2[p.id] = p.answer; });

    if (p3Res?.content) {
      _part3AllParsed = parseQuestionsMarkdown(p3Res.content);
      _fileAnswersPart3 = {};
      _part3AllParsed.forEach((p) => { if (p.answer) _fileAnswersPart3[p.id] = p.answer; });
    }

    let [drawnP1, drawnP2] = [[], []];
    try {
      const [d1, d2] = await Promise.all([
        fetch('/api/drawn-history?part=p1').then((r) => r.ok ? r.json() : { drawn_ids: [] }),
        fetch('/api/drawn-history?part=p2').then((r) => r.ok ? r.json() : { drawn_ids: [] }),
      ]);
      drawnP1 = d1.drawn_ids || [];
      drawnP2 = d2.drawn_ids || [];
    } catch { /* ignore */ }

    let p1Selected;
    if (_p1DrawMode === 'topic') {
      const groups = _groupByTopic(p1All);
      const topicNums = Object.keys(groups);
      const drawnTopics = new Set(drawnP1.filter((id) => id.startsWith('topic-')).map((id) => id.replace('topic-', '')));
      let undrawnTopics = topicNums.filter((t) => !drawnTopics.has(t));
      if (undrawnTopics.length === 0) undrawnTopics = topicNums;
      const chosenTopic = _shuffle(undrawnTopics)[0];
      p1Selected = chosenTopic ? groups[chosenTopic] : [];
    } else {
      const p1Set = new Set(drawnP1);
      let p1Undrawn = p1All.filter((p) => !p1Set.has(p.id));
      if (p1Undrawn.length < 5) p1Undrawn = p1All;
      p1Selected = _shuffle(p1Undrawn).slice(0, 5);
    }

    state.part1Parsed = p1Selected;
    state.part1Questions = p1Selected.map((p) => p.question);
    state.part1Answers = p1Selected.map((p) => p.answer || _fileAnswers[p.id] || '');
    state.part1Index = 0;

    const p2Set = new Set(drawnP2);
    let p2Undrawn = p2All.filter((p) => !p2Set.has(p.id));
    if (p2Undrawn.length === 0) p2Undrawn = p2All;
    const p2Selected = _shuffle(p2Undrawn)[0];
    _currentPart2Id = p2Selected.id;
    state.part2Topic = p2Selected.question;

    try {
      await state.recorder.init();
    } catch {
      alert('Microphone access denied.');
      state.mockMode = false;
      return;
    }

    showScreen('part1-practice');
    runPart1Question();
  } catch (err) {
    alert('Failed to start mock test: ' + err.message);
    state.mockMode = false;
  }
}

// ---------------------------------------------------------------------------
// Part 1 — Practice flow
// ---------------------------------------------------------------------------
async function startPart1() {
  const parsed = parseQuestionsMarkdown($('#part1-md-input').value);
  if (parsed.length === 0) {
    alert('No questions found. Use the # Qx-y: format.');
    return;
  }

  state.mockMode = false;
  state.part1Parsed = parsed;
  state.part1Questions = parsed.map((p) => p.question);
  state.part1Answers = parsed.map((p) => p.answer || _fileAnswers[p.id] || '');
  state.part1Index = 0;
  state.part1Recordings = [];
  state.part1Transcripts = [];
  state.sessionId = generateSessionId();

  try {
    await state.recorder.init();
  } catch {
    alert('Microphone access denied. Please allow microphone and try again.');
    return;
  }

  showScreen('part1-practice');
  runPart1Question();
}

async function runPart1Question() {
  const idx = state.part1Index;
  const total = state.part1Questions.length;
  const q = state.part1Questions[idx];

  $('#part1-counter').textContent = `Q${idx + 1} / ${total}`;
  $('#part1-question-text').textContent = q;

  const ok = await readingCountdown(
    $('#part1-timer-text'), $('#part1-ring'), $('#part1-rec-badge'),
  );
  if (!ok) return;

  $('#part1-rec-badge').classList.add('active');
  $('#part1-rec-badge').querySelector('.rec-label').textContent = 'Recording';
  state.recorder.start();

  state.part1Timer = new Timer(
    45,
    $('#part1-ring'),
    $('#part1-timer-text'),
    {
      onWarning: () => playBeep(600, 100),
      onComplete: () => advancePart1(),
    },
  );
  state.part1Timer.start();
}

async function advancePart1() {
  const wasReading = cancelReadingCountdown();

  if (state.part1Timer) state.part1Timer.stop();
  $('#part1-rec-badge').classList.remove('active', 'reading');

  let blob;
  if (wasReading) {
    blob = new Blob([], { type: 'audio/webm' });
  } else {
    try {
      blob = await state.recorder.stop();
    } catch {
      blob = new Blob([], { type: 'audio/webm' });
    }
  }
  state.part1Recordings.push(blob);

  state.part1Index++;

  if (state.part1Index < state.part1Questions.length) {
    if (state.part1Timer) state.part1Timer.reset(45);
    runPart1Question();
  } else {
    finishPart1();
  }
}

async function finishPart1() {
  showScreen('processing');
  $('#processing-status').textContent = 'Transcribing audio… this may take a moment';

  const promises = state.part1Recordings.map((blob, i) =>
    transcribeBlob(blob, state.sessionId, `part1_q${i + 1}`),
  );

  try {
    state.part1Transcripts = await Promise.all(promises);
  } catch (err) {
    alert('Transcription failed: ' + err.message);
    showScreen('home');
    return;
  }

  const practicedIds = state.part1Parsed.map((p) => p.id);
  if (_p1DrawMode === 'topic' && practicedIds.length > 0) {
    const topicNum = practicedIds[0].split('-')[0];
    await markDrawn([`topic-${topicNum}`]);
  } else {
    await markDrawn(practicedIds);
  }

  if (state.mockMode) {
    mockTransitionToPart2();
    return;
  }

  await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: state.sessionId,
      type: 'part1',
      created_at: new Date().toISOString(),
      questions: state.part1Questions,
      sample_answers: state.part1Answers,
      transcripts: state.part1Transcripts.map((t) => t.transcript),
      durations: state.part1Transcripts.map((t) => t.duration),
      analyses: state.part1Transcripts.map((t) => t.analysis || {}),
    }),
  }).catch(() => {});

  renderResults();
}

function mockTransitionToPart2() {
  state.part2Notes = '';
  state.part2Recording = null;
  state.part2Transcript = null;

  $('#part2-topic-display').textContent = state.part2Topic;
  $('#part2-notes-area').value = '';

  const topicNum = _currentPart2Id ? _currentPart2Id.split('-')[0] : null;
  loadVocabForTopic(topicNum);

  showScreen('part2-notes');

  state.part2NotesTimer = new Timer(
    120,
    $('#part2-notes-ring'),
    $('#part2-notes-timer'),
    {
      onWarning: () => playBeep(600, 100),
      onComplete: () => startPart2Speaking(),
    },
  );
  state.part2NotesTimer.start();
}

// ---------------------------------------------------------------------------
// Part 2 — Setup
// ---------------------------------------------------------------------------
async function randomPart2() {
  try {
    const res = await fetch('/api/questions/random?part=part2&count=1');
    if (!res.ok) {
      const err = await res.json();
      alert(err.detail || 'Not enough topics in bank');
      return;
    }
    const { questions } = await res.json();
    $('#part2-topic-input').value = questions[0];
  } catch {
    alert('Failed to load topic. Is the question bank populated?');
  }
}

// ---------------------------------------------------------------------------
// Part 2 — Practice flow
// ---------------------------------------------------------------------------
async function startPart2() {
  const topic = $('#part2-topic-input').value.trim();
  if (!topic) {
    alert('Please enter a topic.');
    return;
  }

  state.mockMode = false;
  state.part2Topic = topic;
  state.part2Notes = '';
  state.part2Recording = null;
  state.part2Transcript = null;
  state.sessionId = generateSessionId();

  $('#part2-topic-display').textContent = topic;
  $('#part2-notes-area').value = '';

  const topicNum = _currentPart2Id ? _currentPart2Id.split('-')[0] : null;
  loadVocabForTopic(topicNum);

  showScreen('part2-notes');

  state.part2NotesTimer = new Timer(
    120,
    $('#part2-notes-ring'),
    $('#part2-notes-timer'),
    {
      onWarning: () => playBeep(600, 100),
      onComplete: () => startPart2Speaking(),
    },
  );
  state.part2NotesTimer.start();
}

async function startPart2Speaking() {
  state.part2Notes = $('#part2-notes-area').value.trim();

  try {
    await state.recorder.init();
  } catch {
    alert('Microphone access denied.');
    showScreen('home');
    return;
  }

  $('#part2-topic-display-2').textContent = state.part2Topic;
  $('#part2-notes-reminder').textContent = state.part2Notes || '(no notes)';

  showScreen('part2-speaking');

  await readingCountdown(
    $('#part2-speak-timer'), $('#part2-speak-ring'), $('#part2-rec-badge'),
  );

  $('#part2-rec-badge').classList.add('active');
  $('#part2-rec-badge').querySelector('.rec-label').textContent = 'Recording';
  state.recorder.start();

  state.part2SpeakTimer = new Timer(
    120,
    $('#part2-speak-ring'),
    $('#part2-speak-timer'),
    {
      onWarning: () => playBeep(600, 100),
      onComplete: () => finishPart2(),
    },
  );
  state.part2SpeakTimer.start();
}

async function finishPart2() {
  if (state.part2SpeakTimer) state.part2SpeakTimer.stop();
  $('#part2-rec-badge').classList.remove('active');

  let blob;
  try {
    blob = await state.recorder.stop();
  } catch {
    blob = new Blob([], { type: 'audio/webm' });
  }
  state.part2Recording = blob;

  if (_currentPart2Id) {
    await markDrawnPart2([_currentPart2Id]);
  }

  const topicNum = _currentPart2Id ? _currentPart2Id.split('-')[0] : null;
  const part3Qs = topicNum
    ? _part3AllParsed.filter((p) => p.id.startsWith(topicNum + '-'))
    : [];

  if (part3Qs.length > 0) {
    startPart3(part3Qs);
  } else {
    await transcribeAndFinishPart2();
  }
}

async function transcribeAndFinishPart2() {
  showScreen('processing');
  $('#processing-status').textContent = 'Transcribing your response…';

  try {
    state.part2Transcript = await transcribeBlob(
      state.part2Recording,
      state.sessionId,
      'part2_speaking',
    );
  } catch (err) {
    alert('Transcription failed: ' + err.message);
    showScreen('home');
    return;
  }

  await savePart2Session();
  renderResults();
}

async function savePart2Session() {
  if (state.mockMode) {
    return saveMockSession();
  }

  const data = {
    session_id: state.sessionId,
    type: 'part2',
    created_at: new Date().toISOString(),
    topic: state.part2Topic,
    topic_id: _currentPart2Id || '',
    notes: state.part2Notes,
    transcript: state.part2Transcript.transcript,
    duration: state.part2Transcript.duration,
    analysis: state.part2Transcript.analysis || {},
    sample_answer: _currentPart2Id ? (_fileAnswersPart2[_currentPart2Id] || '') : '',
  };

  if (state.part3Transcripts.length > 0) {
    data.part3 = {
      questions: state.part3Questions,
      transcripts: state.part3Transcripts.map((t) => t.transcript),
      durations: state.part3Transcripts.map((t) => t.duration),
      analyses: state.part3Transcripts.map((t) => t.analysis || {}),
      sample_answers: state.part3Parsed.map((p) => _fileAnswersPart3[p.id] || ''),
    };
  }

  await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {});
}

async function saveMockSession() {
  const data = {
    session_id: state.sessionId,
    type: 'mock',
    created_at: new Date().toISOString(),
    part1: {
      questions: state.part1Questions,
      sample_answers: state.part1Answers,
      transcripts: state.part1Transcripts.map((t) => t.transcript),
      durations: state.part1Transcripts.map((t) => t.duration),
      analyses: state.part1Transcripts.map((t) => t.analysis || {}),
    },
    part2: {
      topic: state.part2Topic,
      topic_id: _currentPart2Id || '',
      notes: state.part2Notes,
      transcript: state.part2Transcript.transcript,
      duration: state.part2Transcript.duration,
      analysis: state.part2Transcript.analysis || {},
      sample_answer: _currentPart2Id ? (_fileAnswersPart2[_currentPart2Id] || '') : '',
    },
  };

  if (state.part3Transcripts.length > 0) {
    data.part3 = {
      questions: state.part3Questions,
      transcripts: state.part3Transcripts.map((t) => t.transcript),
      durations: state.part3Transcripts.map((t) => t.duration),
      analyses: state.part3Transcripts.map((t) => t.analysis || {}),
      sample_answers: state.part3Parsed.map((p) => _fileAnswersPart3[p.id] || ''),
    };
  }

  await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {});

  state.mockMode = false;
}

// ---------------------------------------------------------------------------
// Part 3 — Practice flow
// ---------------------------------------------------------------------------
async function startPart3(questions) {
  state.part3Parsed = questions;
  state.part3Questions = questions.map((q) => q.question);
  state.part3Index = 0;
  state.part3Recordings = [];
  state.part3Transcripts = [];

  try {
    await state.recorder.init();
  } catch {
    alert('Microphone access denied.');
    await transcribeAndFinishPart2();
    return;
  }

  showScreen('part3-practice');
  runPart3Question();
}

async function runPart3Question() {
  const idx = state.part3Index;
  const total = state.part3Questions.length;
  const q = state.part3Questions[idx];

  $('#part3-counter').textContent = `Q${idx + 1} / ${total}`;
  $('#part3-question-text').textContent = q;

  const ok = await readingCountdown(
    $('#part3-timer-text'), $('#part3-ring'), $('#part3-rec-badge'),
  );
  if (!ok) return;

  $('#part3-rec-badge').classList.add('active');
  $('#part3-rec-badge').querySelector('.rec-label').textContent = 'Recording';
  state.recorder.start();

  state.part3Timer = new Timer(
    60,
    $('#part3-ring'),
    $('#part3-timer-text'),
    {
      onWarning: () => playBeep(600, 100),
      onComplete: () => advancePart3(),
    },
  );
  state.part3Timer.start();
}

async function advancePart3() {
  const wasReading = cancelReadingCountdown();

  if (state.part3Timer) state.part3Timer.stop();
  $('#part3-rec-badge').classList.remove('active', 'reading');

  let blob;
  if (wasReading) {
    blob = new Blob([], { type: 'audio/webm' });
  } else {
    try {
      blob = await state.recorder.stop();
    } catch {
      blob = new Blob([], { type: 'audio/webm' });
    }
  }
  state.part3Recordings.push(blob);

  state.part3Index++;

  if (state.part3Index < state.part3Questions.length) {
    if (state.part3Timer) state.part3Timer.reset(60);
    runPart3Question();
  } else {
    finishPart3();
  }
}

async function finishPart3() {
  showScreen('processing');
  $('#processing-status').textContent = 'Transcribing Part 2 & 3 responses…';

  const part2Promise = transcribeBlob(
    state.part2Recording,
    state.sessionId,
    'part2_speaking',
  );

  const part3Promises = state.part3Recordings.map((blob, i) =>
    transcribeBlob(blob, state.sessionId, `part3_q${i + 1}`),
  );

  try {
    const [p2Result, ...p3Results] = await Promise.all([part2Promise, ...part3Promises]);
    state.part2Transcript = p2Result;
    state.part3Transcripts = p3Results;
  } catch (err) {
    alert('Transcription failed: ' + err.message);
    showScreen('home');
    return;
  }

  await savePart2Session();
  renderResults();
}

// ---------------------------------------------------------------------------
// Analysis rendering helpers
// ---------------------------------------------------------------------------
function rateWpm(wpm) {
  if (wpm >= 110 && wpm <= 160) return 'good';
  if (wpm >= 80 && wpm < 110) return 'ok';
  return 'weak';
}

function rateTtr(ttr) {
  if (ttr >= 0.6) return 'good';
  if (ttr >= 0.45) return 'ok';
  return 'weak';
}

function rateFillers(count, duration) {
  const perMin = duration > 0 ? (count / duration) * 60 : count;
  if (perMin <= 2) return 'good';
  if (perMin <= 4) return 'ok';
  return 'weak';
}

function bandClass(score) {
  if (score >= 7) return 'b7plus';
  if (score >= 6) return 'b6';
  return 'b5minus';
}

function buildBandHtml(band) {
  if (!band || !band.overall) return '';
  return `
    <div class="band-scores">
      <div class="band-card band-overall">
        <div class="band-value ${bandClass(band.overall)}">${band.overall}</div>
        <div class="band-label">Overall</div>
      </div>
      <div class="band-card">
        <div class="band-value ${bandClass(band.fluency_coherence)}">${band.fluency_coherence}</div>
        <div class="band-label">Fluency</div>
      </div>
      <div class="band-card">
        <div class="band-value ${bandClass(band.lexical_resource)}">${band.lexical_resource}</div>
        <div class="band-label">Lexical</div>
      </div>
      <div class="band-card">
        <div class="band-value ${bandClass(band.grammatical_range)}">${band.grammatical_range}</div>
        <div class="band-label">Grammar</div>
      </div>
      ${band.pronunciation ? `<div class="band-card">
        <div class="band-value ${bandClass(band.pronunciation)}">${band.pronunciation}</div>
        <div class="band-label">Pronun.</div>
      </div>` : ''}
    </div>
    <div class="band-disclaimer">* Pronunciation estimated via Whisper confidence; FC/LR/GRA from transcript analysis</div>`;
}

function ratePronunciation(score) {
  if (score >= 7) return 'good';
  if (score >= 6) return 'ok';
  return 'weak';
}

function buildPronunciationHtml(p) {
  if (!p || !p.score) return '';

  let lowWordsHtml = '';
  if (p.low_confidence_words?.length) {
    const items = p.low_confidence_words
      .map((w) => `<span class="pronun-word">${escapeHtml(w.word)} <small>(${(w.probability * 100).toFixed(0)}%)</small></span>`)
      .join(' ');
    lowWordsHtml = `<div class="pronun-low-words"><span class="metric-label">Unclear words:</span> ${items}</div>`;
  }

  return `
    <div class="analysis-section">
      <div class="analysis-title">Pronunciation (Whisper Confidence)</div>
      <div class="analysis-grid">
        <div class="analysis-metric">
          <span class="metric-label">Clarity</span>
          <span class="metric-value ${ratePronunciation(p.score)}">${p.clarity}</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Score</span>
          <span class="metric-value ${ratePronunciation(p.score)}">${p.score}</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Avg confidence</span>
          <span class="metric-value">${(p.avg_confidence * 100).toFixed(1)}%</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Unclear</span>
          <span class="metric-value ${p.unclear_count > 3 ? 'weak' : ''}">${p.unclear_count} / ${p.total_words}</span>
        </div>
      </div>
      ${lowWordsHtml}
    </div>`;
}

function buildAnalysisHtml(a) {
  if (!a || !a.word_count) return '';

  const repeatedNote = a.repeated_words?.length
    ? `<div class="analysis-notes">Repeated: ${a.repeated_words.map((w) => `"${w}"`).join(', ')}</div>`
    : '';

  return `
    ${buildBandHtml(a.band)}
    <div class="analysis-section">
      <div class="analysis-title">Speech Metrics</div>
      <div class="analysis-grid">
        <div class="analysis-metric">
          <span class="metric-label">Speaking rate</span>
          <span class="metric-value ${rateWpm(a.wpm)}">${a.wpm} WPM</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Word count</span>
          <span class="metric-value">${a.word_count}</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Fillers</span>
          <span class="metric-value ${rateFillers(a.filler_count, a.word_count / (a.wpm || 1) * 60)}">${a.filler_count}</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Unique words</span>
          <span class="metric-value">${a.unique_words}</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Vocab diversity</span>
          <span class="metric-value ${rateTtr(a.vocabulary_diversity)}">${a.vocabulary_diversity} TTR</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Avg word length</span>
          <span class="metric-value">${a.avg_word_length}</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Discourse markers</span>
          <span class="metric-value">${a.discourse_markers}</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Complex structures</span>
          <span class="metric-value">${a.complex_structures}</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Sentences</span>
          <span class="metric-value">${a.sentence_count}</span>
        </div>
        <div class="analysis-metric">
          <span class="metric-label">Avg sent length</span>
          <span class="metric-value">${a.avg_sentence_length} words</span>
        </div>
        ${repeatedNote}
      </div>
    </div>
    ${buildPronunciationHtml(a.pronunciation)}`;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function renderResults() {
  const container = $('#results-content');
  const isMock = state.part1Transcripts.length > 0 && state.part2Transcript;
  const title = $('#results-title');
  if (title) title.textContent = isMock ? 'Mock Test Results' : 'Results';

  container.innerHTML =
    `<div class="hl-legend">` +
    `<span class="hl-leg-filler">Fillers</span>` +
    `<span class="hl-leg-discourse">Discourse markers</span>` +
    `<span class="hl-leg-complex">Complex structures</span>` +
    `</div>`;

  if (state.part1Transcripts.length > 0) {
    state.part1Questions.forEach((q, i) => {
      const t = state.part1Transcripts[i] || {};
      const answer = state.part1Answers[i] || '';
      const label = state.part1Parsed[i]?.id || `${i + 1}`;
      const blobUrl = state.part1Recordings[i]
        ? URL.createObjectURL(state.part1Recordings[i])
        : null;

      const sampleHtml = answer
        ? `<div class="sample-answer">
             <div class="sample-label">Sample Answer</div>
             <div class="sample-text">${escapeHtml(answer)}</div>
           </div>`
        : '';

      container.innerHTML += `
        <div class="result-card">
          <h4>Q${escapeHtml(label)}</h4>
          <div class="question-text">${escapeHtml(q)}</div>
          <div class="transcript-text">${highlightTranscript(t.transcript || '—')}</div>
          <div class="duration-text">Duration: ${t.duration || 0}s</div>
          ${blobUrl ? `<audio controls src="${blobUrl}"></audio>` : ''}
          ${buildAnalysisHtml(t.analysis)}
          ${sampleHtml}
        </div>`;
    });
  }

  if (state.part2Transcript) {
    const t = state.part2Transcript;
    const blobUrl = state.part2Recording
      ? URL.createObjectURL(state.part2Recording)
      : null;
    const sampleAnswer = _currentPart2Id ? (_fileAnswersPart2[_currentPart2Id] || '') : '';
    const sampleHtml = sampleAnswer
      ? `<div class="sample-answer">
           <div class="sample-label">Sample Answer</div>
           <div class="sample-text">${escapeHtml(sampleAnswer)}</div>
         </div>`
      : '';

    const coverage = checkBulletCoverage(state.part2Topic, t.transcript);
    container.innerHTML += `
      <div class="result-card">
        <h4>Topic${_currentPart2Id ? ` (Q${_currentPart2Id})` : ''}</h4>
        <div class="question-text">${escapeHtml(state.part2Topic)}</div>
      </div>
      <div class="result-card">
        <h4>Your Notes</h4>
        <div class="transcript-text">${escapeHtml(state.part2Notes || '(no notes)')}</div>
      </div>
      <div class="result-card">
        <h4>Part 2 — Your Response</h4>
        <div class="transcript-text">${highlightTranscript(t.transcript || '—')}</div>
        <div class="duration-text">Duration: ${t.duration || 0}s</div>
        ${blobUrl ? `<audio controls src="${blobUrl}"></audio>` : ''}
        ${buildAnalysisHtml(t.analysis)}
        ${buildCoverageHtml(coverage)}
        ${buildVocabUsageHtml(t.transcript)}
        ${sampleHtml}
      </div>`;

    if (state.part3Transcripts.length > 0) {
      state.part3Questions.forEach((q, i) => {
        const p3t = state.part3Transcripts[i] || {};
        const p3Label = state.part3Parsed[i]?.id || `${i + 1}`;
        const p3BlobUrl = state.part3Recordings[i]
          ? URL.createObjectURL(state.part3Recordings[i])
          : null;
        const p3Answer = _fileAnswersPart3[p3Label] || '';
        const p3SampleHtml = p3Answer
          ? `<div class="sample-answer">
               <div class="sample-label">Sample Answer</div>
               <div class="sample-text">${escapeHtml(p3Answer)}</div>
             </div>`
          : '';

        container.innerHTML += `
          <div class="result-card">
            <h4>Part 3 — Q${escapeHtml(p3Label)}</h4>
            <div class="question-text">${escapeHtml(q)}</div>
            <div class="transcript-text">${highlightTranscript(p3t.transcript || '—')}</div>
            <div class="duration-text">Duration: ${p3t.duration || 0}s</div>
            ${p3BlobUrl ? `<audio controls src="${p3BlobUrl}"></audio>` : ''}
            ${buildAnalysisHtml(p3t.analysis)}
            ${p3SampleHtml}
          </div>`;
      });
    }
  }

  showScreen('results');
}

// ---------------------------------------------------------------------------
// Part 2 Bullet Point Coverage Check
// ---------------------------------------------------------------------------
const _STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'or', 'and',
  'but', 'not', 'no', 'if', 'it', 'its', 'this', 'that', 'you', 'your',
  'he', 'she', 'his', 'her', 'they', 'them', 'their', 'we', 'our',
  'what', 'when', 'where', 'why', 'how', 'who', 'whom', 'which',
]);

function extractBulletPoints(topicText) {
  if (!topicText) return [];
  const lines = topicText.split('\n');
  const bullets = [];
  let inBullets = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^you should say/i.test(trimmed)) {
      inBullets = true;
      continue;
    }
    if (inBullets) {
      const bulletMatch = trimmed.match(/^[-•]\s*(.+)$/);
      const andMatch = trimmed.match(/^and\s+(.+)$/i);
      if (bulletMatch) {
        bullets.push(bulletMatch[1].trim().replace(/[.?!]+$/, ''));
      } else if (andMatch) {
        bullets.push(andMatch[1].trim().replace(/[.?!]+$/, ''));
      }
    }
  }
  return bullets;
}

function extractKeywords(bullet) {
  return bullet
    .toLowerCase()
    .replace(/[.,!?;:'"()]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !_STOP_WORDS.has(w));
}

function checkBulletCoverage(topicText, transcript) {
  const bullets = extractBulletPoints(topicText);
  if (bullets.length === 0) return null;

  const lowerTranscript = (transcript || '').toLowerCase();
  const results = bullets.map((bullet) => {
    const keywords = extractKeywords(bullet);
    if (keywords.length === 0) return { bullet, covered: true, matchedKeywords: [], keywords };

    const matched = keywords.filter((kw) => lowerTranscript.includes(kw));
    const ratio = matched.length / keywords.length;
    return {
      bullet,
      covered: ratio >= 0.4,
      matchedKeywords: matched,
      keywords,
      ratio: Math.round(ratio * 100),
    };
  });

  const coveredCount = results.filter((r) => r.covered).length;
  return { bullets: results, total: results.length, covered: coveredCount };
}

function buildCoverageHtml(coverage) {
  if (!coverage) return '';

  const items = coverage.bullets.map((b) => {
    const icon = b.covered ? '✅' : '❌';
    const cls = b.covered ? 'cov-yes' : 'cov-no';
    return `<div class="coverage-item ${cls}">` +
      `<span class="coverage-icon">${icon}</span>` +
      `<span class="coverage-text">${escapeHtml(b.bullet)}</span>` +
      `</div>`;
  }).join('');

  return `
    <div class="analysis-section">
      <div class="analysis-title">Bullet Point Coverage (${coverage.covered}/${coverage.total})</div>
      <div class="coverage-list">${items}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Topic Vocabulary
// ---------------------------------------------------------------------------
let _currentVocab = [];

async function loadVocabForTopic(topicNum) {
  _currentVocab = [];
  const panel = $('#part2-vocab-panel');
  if (!panel || !topicNum) { if (panel) panel.innerHTML = ''; return; }

  try {
    const res = await fetch(`/api/vocab?topic=${topicNum}`);
    if (!res.ok) { panel.innerHTML = ''; return; }
    const data = await res.json();
    _currentVocab = data.vocab || [];

    if (_currentVocab.length === 0) { panel.innerHTML = ''; return; }

    const items = _currentVocab
      .map((v) => `<span class="vocab-chip">${escapeHtml(v)}</span>`)
      .join('');
    panel.innerHTML = `<div class="vocab-title">Suggested Vocabulary (Band 7+)</div><div class="vocab-chips">${items}</div>`;
  } catch {
    panel.innerHTML = '';
  }
}

function buildVocabUsageHtml(transcript) {
  if (!_currentVocab.length || !transcript) return '';

  const lower = transcript.toLowerCase();
  const used = _currentVocab.filter((v) => lower.includes(v.toLowerCase()));
  const unused = _currentVocab.filter((v) => !lower.includes(v.toLowerCase()));

  if (used.length === 0 && unused.length === 0) return '';

  const usedHtml = used.map((v) => `<span class="vocab-chip vocab-used">${escapeHtml(v)}</span>`).join('');
  const unusedHtml = unused.map((v) => `<span class="vocab-chip vocab-unused">${escapeHtml(v)}</span>`).join('');

  return `
    <div class="analysis-section">
      <div class="analysis-title">Vocabulary Usage (${used.length}/${_currentVocab.length})</div>
      <div class="vocab-chips">${usedHtml}${unusedHtml}</div>
    </div>`;
}

function buildAnalysisMarkdown(a) {
  if (!a || !a.word_count) return '';
  let s = '';
  if (a.band) {
    s += `**Estimated Band:** Overall ${a.band.overall} · `;
    s += `FC ${a.band.fluency_coherence} · LR ${a.band.lexical_resource} · GRA ${a.band.grammatical_range}`;
    if (a.band.pronunciation) s += ` · P ${a.band.pronunciation}`;
    s += ` *(FC/LR/GRA from transcript; P from Whisper confidence)*\n`;
  }
  s += `**Speech Metrics:** ${a.wpm} WPM · ${a.word_count} words · ${a.filler_count} fillers · `;
  s += `TTR ${a.vocabulary_diversity} · ${a.discourse_markers} discourse markers · `;
  s += `${a.complex_structures} complex structures · ${a.sentence_count} sentences`;
  if (a.repeated_words?.length) {
    s += ` · Repeated: ${a.repeated_words.join(', ')}`;
  }
  return s + '\n';
}

function buildMarkdown() {
  const now = new Date().toLocaleString();
  const isMock = state.part1Transcripts.length > 0 && state.part2Transcript;
  let md = '';

  if (isMock) {
    md += `# IELTS Speaking Mock Test\nDate: ${now}\n\n`;
  }

  if (state.part1Transcripts.length > 0) {
    md += `## IELTS Speaking Part 1${isMock ? '' : ' Practice'}\n${isMock ? '' : `Date: ${now}\n`}\n`;
    state.part1Questions.forEach((q, i) => {
      const t = state.part1Transcripts[i] || {};
      const answer = state.part1Answers[i] || '';
      const label = state.part1Parsed[i]?.id || `${i + 1}`;
      md += `### Q${label}\n`;
      md += `**Q:** ${q}\n`;
      md += `**My Answer:** ${t.transcript || '—'}\n`;
      if (answer) md += `**Sample Answer:** ${answer}\n`;
      md += `**Duration:** ${t.duration || 0}s\n`;
      md += buildAnalysisMarkdown(t.analysis);
      md += '\n';
    });
    md += `---\n\nPlease analyze my Part 1 responses for:\n`;
    md += `1. Fluency and coherence\n`;
    md += `2. Lexical resource (vocabulary range)\n`;
    md += `3. Grammatical range and accuracy\n`;
    md += `4. Pronunciation issues (based on transcript)\n`;
    md += `5. Compare my answer with the sample answer and identify gaps\n`;
    md += `6. Estimated band score for Part 1\n`;
    md += `7. Specific suggestions for improvement\n`;
    md += `\n**以 IELTS Band 7 為標準，請針對每個回答：**\n`;
    md += `- 逐句標出文法錯誤、用詞不當、搭配不自然之處，並提供修正後的句子\n`;
    md += `- 指出哪些表達過於簡單或重複，建議替換為 Band 7 水準的詞彙/片語\n`;
    md += `- 若回答缺乏連貫性或篇章標記，示範如何加入適當的 discourse markers\n`;
    md += `- 提供一段修正後的完整回答範例（Band 7 版本），方便我對照學習\n`;
  }

  if (state.part2Transcript) {
    const p2Sample = _currentPart2Id ? (_fileAnswersPart2[_currentPart2Id] || '') : '';
    md += `## IELTS Speaking Part 2 & 3${isMock ? '' : ' Practice'}\n${isMock ? '' : `Date: ${now}\n`}\n`;
    md += `### Topic Card\n${state.part2Topic}\n\n`;
    md += `### My Notes\n${state.part2Notes || '(no notes)'}\n\n`;
    md += `### Part 2 — My Response\n${state.part2Transcript.transcript || '—'}\n`;
    md += `**Duration:** ${state.part2Transcript.duration || 0}s\n`;
    md += buildAnalysisMarkdown(state.part2Transcript.analysis);
    if (p2Sample) md += `\n### Sample Answer\n${p2Sample}\n`;

    if (state.part3Transcripts.length > 0) {
      md += `\n### Part 3 — Discussion\n\n`;
      state.part3Questions.forEach((q, i) => {
        const p3t = state.part3Transcripts[i] || {};
        const p3Label = state.part3Parsed[i]?.id || `${i + 1}`;
        const p3Sample = _fileAnswersPart3[p3Label] || '';
        md += `#### Q${p3Label}\n`;
        md += `**Q:** ${q}\n`;
        md += `**My Answer:** ${p3t.transcript || '—'}\n`;
        if (p3Sample) md += `**Sample Answer:** ${p3Sample}\n`;
        md += `**Duration:** ${p3t.duration || 0}s\n`;
        md += buildAnalysisMarkdown(p3t.analysis);
        md += '\n';
      });
    }

    md += `---\n\nPlease analyze my Part 2 & 3 responses for:\n`;
    md += `1. Task achievement (did I cover all bullet points in Part 2?)\n`;
    md += `2. Fluency and coherence\n`;
    md += `3. Lexical resource\n`;
    md += `4. Grammatical range and accuracy\n`;
    if (p2Sample) md += `5. Compare my Part 2 answer with the sample answer and identify gaps\n`;
    const n = p2Sample ? 6 : 5;
    if (state.part3Transcripts.length > 0) md += `${n}. Evaluate my Part 3 discussion depth and argumentation\n`;
    const m = state.part3Transcripts.length > 0 ? n + 1 : n;
    md += `${m}. Estimated band score for Part 2 & 3\n`;
    md += `${m + 1}. Specific suggestions for improvement\n`;
    md += `\n**以 IELTS Band 7 為標準，請針對每個回答：**\n`;
    md += `- 逐句標出文法錯誤、用詞不當、搭配不自然之處，並提供修正後的句子\n`;
    md += `- 指出哪些表達過於簡單或重複，建議替換為 Band 7 水準的詞彙/片語\n`;
    md += `- 若回答缺乏連貫性或篇章標記，示範如何加入適當的 discourse markers\n`;
    md += `- Part 2：檢查是否遺漏 bullet points，並示範如何自然地涵蓋所有要點\n`;
    md += `- Part 3：檢查論點是否有深度，是否有正反論述，建議如何強化論證\n`;
    md += `- 提供一段修正後的完整回答範例（Band 7 版本），方便我對照學習\n`;
  }

  return md;
}

async function downloadPdf() {
  if (!state.sessionId) {
    alert('No session to export.');
    return;
  }
  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/pdf`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      alert(`PDF export failed: ${err.detail || 'Unknown error'}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ielts_session_${state.sessionId}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch {
    alert('Failed to download PDF.');
  }
}

async function copyResults() {
  const md = buildMarkdown();
  try {
    await navigator.clipboard.writeText(md);
    const toast = $('#copy-toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  } catch {
    // Fallback: select a textarea
    const ta = document.createElement('textarea');
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

// ---------------------------------------------------------------------------
// Home Stats (streak + weakness)
// ---------------------------------------------------------------------------
async function loadHomeStats() {
  const container = $('#home-stats');
  if (!container) return;

  try {
    const res = await fetch('/api/stats');
    if (!res.ok) { container.innerHTML = ''; return; }
    const data = await res.json();

    let html = '<div class="home-stats-row">';

    if (data.streak > 0) {
      html += `<div class="streak-badge">` +
        `<span class="streak-fire">🔥</span>` +
        `<span class="streak-count">${data.streak}</span>` +
        `<span class="streak-label">day${data.streak > 1 ? 's' : ''} streak</span>` +
        `</div>`;
    }

    if (data.weakness) {
      const w = data.weakness;
      html += `<div class="weakness-alert">` +
        `<span class="weakness-icon">⚠️</span>` +
        `<span class="weakness-text">Focus on <span class="weakness-area">${escapeHtml(w.label)}</span>` +
        ` — avg <span class="weakness-score">${w.avg}</span></span>` +
        `</div>`;
    }

    html += '</div>';

    if (data.streak > 0 || data.weakness) {
      container.innerHTML = html;
    } else {
      container.innerHTML = '';
    }
  } catch {
    container.innerHTML = '';
  }
}

// Load stats on initial page load
document.addEventListener('DOMContentLoaded', () => { loadHomeStats(); });

// ---------------------------------------------------------------------------
// Practice History
// ---------------------------------------------------------------------------
async function loadHistory() {
  const container = $('#history-content');
  container.innerHTML = '<div class="processing-content"><div class="spinner"></div></div>';

  try {
    const res = await fetch('/api/sessions?full=true');
    const { sessions } = await res.json();

    if (!sessions || sessions.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted)">No practice sessions yet.</p>';
      return;
    }

    const bandDataPoints = extractBandTrend(sessions);
    let html = '';

    if (bandDataPoints.length >= 2) {
      html += renderTrendChart(bandDataPoints);
    }

    html += '<div class="history-list">';
    for (const s of sessions) {
      html += renderHistoryCard(s);
    }
    html += '</div>';

    container.innerHTML = html;
  } catch {
    container.innerHTML = '<p style="color:var(--danger)">Failed to load history.</p>';
  }
}

function extractBandTrend(sessions) {
  const points = [];
  for (const s of [...sessions].reverse()) {
    const date = s.created_at ? new Date(s.created_at) : null;
    if (!date) continue;

    const analyses = [];
    if (s.type === 'part1' && Array.isArray(s.analyses)) {
      analyses.push(...s.analyses.filter((a) => a?.band));
    }
    if (s.type === 'part2' && s.analysis?.band) {
      analyses.push(s.analysis);
    }
    if (s.part3?.analyses) {
      analyses.push(...s.part3.analyses.filter((a) => a?.band));
    }

    if (analyses.length === 0) continue;

    const avg = (key) => {
      const vals = analyses.map((a) => a.band[key]).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    points.push({
      date,
      label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      fc: avg('fluency_coherence'),
      lr: avg('lexical_resource'),
      gra: avg('grammatical_range'),
      pron: avg('pronunciation'),
      overall: avg('overall'),
      type: s.type,
    });
  }
  return points;
}

function renderTrendChart(points) {
  const W = 560, H = 200, PAD_L = 40, PAD_R = 20, PAD_T = 20, PAD_B = 35;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const minBand = 4.0, maxBand = 9.0;
  const bandRange = maxBand - minBand;

  const xStep = points.length > 1 ? chartW / (points.length - 1) : chartW / 2;

  const toX = (i) => PAD_L + i * xStep;
  const toY = (val) => PAD_T + chartH - ((val - minBand) / bandRange) * chartH;

  const makeLine = (key, color) => {
    const pts = points
      .map((p, i) => p[key] != null ? `${toX(i)},${toY(p[key])}` : null)
      .filter(Boolean);
    if (pts.length < 2) return '';
    return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts.join(' ')}" />` +
      pts.map((pt) => `<circle cx="${pt.split(',')[0]}" cy="${pt.split(',')[1]}" r="3" fill="${color}" />`).join('');
  };

  const gridLines = [4, 5, 6, 7, 8, 9].map((b) => {
    const y = toY(b);
    return `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="var(--border)" stroke-width="0.5" />` +
      `<text x="${PAD_L - 8}" y="${y + 4}" fill="var(--text-muted)" font-size="11" text-anchor="end">${b}</text>`;
  }).join('');

  const xLabels = points.map((p, i) => {
    if (points.length > 10 && i % 2 !== 0) return '';
    return `<text x="${toX(i)}" y="${H - 5}" fill="var(--text-muted)" font-size="10" text-anchor="middle">${p.label}</text>`;
  }).join('');

  return `
    <div class="trend-chart-wrapper">
      <div class="trend-chart-title">Band Score Trend</div>
      <svg class="trend-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${gridLines}
        ${xLabels}
        ${makeLine('fc', '#00d4aa')}
        ${makeLine('lr', '#ffc107')}
        ${makeLine('gra', '#70a1ff')}
        ${makeLine('pron', '#ff6b9d')}
        ${makeLine('overall', '#e8e8f0')}
      </svg>
      <div class="trend-legend">
        <span style="color:#00d4aa">FC</span>
        <span style="color:#ffc107">LR</span>
        <span style="color:#70a1ff">GRA</span>
        <span style="color:#ff6b9d">P</span>
        <span style="color:#e8e8f0">Overall</span>
      </div>
    </div>`;
}

function renderHistoryCard(s) {
  const date = s.created_at
    ? new Date(s.created_at).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : 'Unknown date';

  const typeLabel = s.type === 'part1' ? 'Part 1' : s.type === 'part2' ? 'Part 2 & 3' : s.type === 'mock' ? 'Mock Test' : s.type || '—';

  let bandHtml = '';
  const bandData = _getSessionOverallBand(s);
  if (bandData) {
    bandHtml = `
      <div class="history-bands">
        <span class="hb-item ${bandClass(bandData.overall)}">Overall ${bandData.overall}</span>
        <span class="hb-item ${bandClass(bandData.fc)}">FC ${bandData.fc}</span>
        <span class="hb-item ${bandClass(bandData.lr)}">LR ${bandData.lr}</span>
        <span class="hb-item ${bandClass(bandData.gra)}">GRA ${bandData.gra}</span>
        ${bandData.pron != null ? `<span class="hb-item ${bandClass(bandData.pron)}">P ${bandData.pron}</span>` : ''}
      </div>`;
  }

  let detailHtml = '';
  if (s.type === 'part1' && Array.isArray(s.questions)) {
    detailHtml = `<div class="history-detail">${s.questions.length} questions</div>`;
  } else if (s.type === 'part2' && s.topic) {
    const topicSnip = s.topic.length > 80 ? s.topic.slice(0, 80) + '…' : s.topic;
    detailHtml = `<div class="history-detail">${escapeHtml(topicSnip)}</div>`;
  }

  return `
    <div class="history-card" data-action="view-session" data-session-id="${s.session_id}" role="button" tabindex="0">
      <div class="history-card-header">
        <span class="history-type">${typeLabel}</span>
        <span class="history-date">${date}</span>
      </div>
      ${bandHtml}
      ${detailHtml}
      <div class="history-card-arrow">&rsaquo;</div>
    </div>`;
}

function _getSessionOverallBand(s) {
  const analyses = [];
  if (s.type === 'part1' && Array.isArray(s.analyses)) {
    analyses.push(...s.analyses.filter((a) => a?.band));
  }
  if (s.type === 'part2' && s.analysis?.band) {
    analyses.push(s.analysis);
  }
  if (s.type === 'mock') {
    if (Array.isArray(s.part1?.analyses)) analyses.push(...s.part1.analyses.filter((a) => a?.band));
    if (s.part2?.analysis?.band) analyses.push(s.part2.analysis);
    if (Array.isArray(s.part3?.analyses)) analyses.push(...s.part3.analyses.filter((a) => a?.band));
  }
  if (s.part3?.analyses) {
    analyses.push(...s.part3.analyses.filter((a) => a?.band));
  }
  if (analyses.length === 0) return null;

  const avg = (key) => {
    const vals = analyses.map((a) => a.band[key]).filter((v) => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 2) / 2 : null;
  };

  return { overall: avg('overall'), fc: avg('fluency_coherence'), lr: avg('lexical_resource'), gra: avg('grammatical_range'), pron: avg('pronunciation') };
}

// ---------------------------------------------------------------------------
// Session Detail View (from history)
// ---------------------------------------------------------------------------
async function viewSessionDetail(sessionId) {
  const container = $('#history-content');
  container.innerHTML = '<div class="processing-content"><div class="spinner"></div></div>';

  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (!res.ok) throw new Error('Not found');
    const s = await res.json();

    const typeLabel = s.type === 'part1' ? 'Part 1 Practice'
      : s.type === 'part2' ? 'Part 2 & 3 Practice'
      : s.type === 'mock' ? 'Mock Test' : s.type || 'Session';
    const date = s.created_at
      ? new Date(s.created_at).toLocaleString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      : '';

    let html = `<button class="btn btn-ghost btn-small" data-action="back-to-history">&larr; Back to list</button>`;
    html += `<div class="session-detail-header">
      <h3>${typeLabel}</h3>
      <span class="history-date">${date}</span>
    </div>`;

    html += `<div class="hl-legend">
      <span class="hl-leg-filler">Fillers</span>
      <span class="hl-leg-discourse">Discourse markers</span>
      <span class="hl-leg-complex">Complex structures</span>
    </div>`;

    const _p = (field) => {
      if (s.type === 'mock') return s.part1?.[field] || [];
      if (s.type === 'part1') return s[field] || [];
      return [];
    };
    const _p2 = (field, fallback) => {
      if (s.type === 'mock') return s.part2?.[field] ?? fallback;
      if (s.type === 'part2') return s[field] ?? fallback;
      return fallback;
    };

    const p1Qs = _p('questions');
    const p1Trans = _p('transcripts');
    const p1Analyses = _p('analyses');
    const p1Samples = _p('sample_answers');
    const p1Durations = _p('durations');

    if (p1Qs.length > 0) {
      if (s.type === 'mock') html += '<h4 class="detail-section-title">Part 1</h4>';
      p1Qs.forEach((q, i) => {
        const transcript = p1Trans[i] || '—';
        const analysis = p1Analyses[i] || {};
        const sample = p1Samples[i] || '';
        const dur = p1Durations[i] || 0;
        const sampleHtml = sample
          ? `<div class="sample-answer"><div class="sample-label">Sample Answer</div><div class="sample-text">${escapeHtml(sample)}</div></div>`
          : '';

        html += `<div class="result-card">
          <h4>Q${i + 1}</h4>
          <div class="question-text">${escapeHtml(q)}</div>
          <div class="transcript-text">${highlightTranscript(transcript)}</div>
          <div class="duration-text">Duration: ${dur}s</div>
          ${buildAnalysisHtml(analysis)}
          ${sampleHtml}
        </div>`;
      });
    }

    const p2Topic = _p2('topic', '');
    const p2Transcript = _p2('transcript', '');
    const p2Analysis = _p2('analysis', {});
    const p2Sample = _p2('sample_answer', '');
    const p2Notes = _p2('notes', '');
    const p2Duration = _p2('duration', 0);

    if (p2Topic) {
      if (s.type === 'mock') html += '<h4 class="detail-section-title">Part 2</h4>';
      html += `<div class="result-card">
        <h4>Topic Card</h4>
        <div class="question-text">${escapeHtml(p2Topic)}</div>
      </div>`;

      if (p2Notes) {
        html += `<div class="result-card">
          <h4>Your Notes</h4>
          <div class="transcript-text">${escapeHtml(p2Notes)}</div>
        </div>`;
      }

      const p2SampleHtml = p2Sample
        ? `<div class="sample-answer"><div class="sample-label">Sample Answer</div><div class="sample-text">${escapeHtml(p2Sample)}</div></div>`
        : '';

      const p2Coverage = checkBulletCoverage(p2Topic, p2Transcript);
      const coverageHtml = buildCoverageHtml(p2Coverage);

      let vocabHtml = '';
      let p2TopicNum = '';
      const p2TopicId = _p2('topic_id', '');
      if (p2TopicId) {
        p2TopicNum = p2TopicId.split('-')[0];
      } else {
        if (_allFileParsedPart2.length === 0) {
          try {
            const p2FileRes = await fetch('/api/load-file?part=part2');
            if (p2FileRes.ok) {
              const p2FileData = await p2FileRes.json();
              _allFileParsedPart2 = parseQuestionsMarkdown(p2FileData.content);
              _allFileParsedPart2.forEach((p) => { if (p.answer) _fileAnswersPart2[p.id] = p.answer; });
            }
          } catch {}
        }
        if (_allFileParsedPart2.length > 0) {
          const topicStart = p2Topic.split('\n')[0].trim().toLowerCase();
          const matched = _allFileParsedPart2.find((p) => p.question.split('\n')[0].trim().toLowerCase() === topicStart);
          if (matched) p2TopicNum = matched.id.split('-')[0];
        }
      }
      if (p2TopicNum) {
        try {
          const vocabRes = await fetch(`/api/vocab?topic=${p2TopicNum}`);
          if (vocabRes.ok) {
            const vocabData = await vocabRes.json();
            const vocabItems = vocabData.vocab || [];
            if (vocabItems.length > 0 && p2Transcript) {
              const lower = p2Transcript.toLowerCase();
              const used = vocabItems.filter((v) => lower.includes(v.toLowerCase()));
              const unused = vocabItems.filter((v) => !lower.includes(v.toLowerCase()));
              const usedChips = used.map((v) => `<span class="vocab-chip vocab-used">${escapeHtml(v)}</span>`).join('');
              const unusedChips = unused.map((v) => `<span class="vocab-chip vocab-unused">${escapeHtml(v)}</span>`).join('');
              vocabHtml = `<div class="analysis-section"><div class="analysis-title">Vocabulary Usage (${used.length}/${vocabItems.length})</div><div class="vocab-chips">${usedChips}${unusedChips}</div></div>`;
            }
          }
        } catch {}
      }

      html += `<div class="result-card">
        <h4>Part 2 — Your Response</h4>
        <div class="transcript-text">${highlightTranscript(p2Transcript || '—')}</div>
        <div class="duration-text">Duration: ${p2Duration}s</div>
        ${buildAnalysisHtml(p2Analysis)}
        ${coverageHtml}
        ${vocabHtml}
        ${p2SampleHtml}
      </div>`;
    }

    const p3 = s.part3 || {};
    const p3Qs = p3.questions || [];
    const p3Trans = p3.transcripts || [];
    const p3Analyses = p3.analyses || [];
    const p3Samples = p3.sample_answers || [];

    if (p3Qs.length > 0) {
      html += '<h4 class="detail-section-title">Part 3</h4>';
      p3Qs.forEach((q, i) => {
        const transcript = p3Trans[i] || '—';
        const analysis = p3Analyses[i] || {};
        const sample = p3Samples[i] || '';
        const sampleHtml = sample
          ? `<div class="sample-answer"><div class="sample-label">Sample Answer</div><div class="sample-text">${escapeHtml(sample)}</div></div>`
          : '';

        html += `<div class="result-card">
          <h4>Part 3 — Q${i + 1}</h4>
          <div class="question-text">${escapeHtml(q)}</div>
          <div class="transcript-text">${highlightTranscript(transcript)}</div>
          <div class="duration-text">Duration: ${p3.durations?.[i] || 0}s</div>
          ${buildAnalysisHtml(analysis)}
          ${sampleHtml}
        </div>`;
      });
    }

    _historyDetailSession = s;
    html += `<div class="detail-actions">
      <button class="btn btn-primary" data-action="copy-history-detail">📋 Copy for Claude Analysis</button>
      <button class="btn btn-secondary" data-action="download-session-pdf" data-session-id="${sessionId}">📄 Download PDF</button>
      <button class="btn btn-ghost" data-action="back-to-history">&larr; Back to list</button>
    </div>
    <div class="copy-toast" id="history-copy-toast">Copied to clipboard!</div>`;

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger)">Failed to load session: ${escapeHtml(err.message)}</p>` +
      '<button class="btn btn-ghost" data-action="back-to-history">&larr; Back to list</button>';
  }
}

let _historyDetailSession = null;

function buildHistoryMarkdown(s) {
  if (!s) return '';
  const now = s.created_at ? new Date(s.created_at).toLocaleString() : 'Unknown';
  let md = '';

  const _p = (field) => {
    if (s.type === 'mock') return s.part1?.[field] || [];
    if (s.type === 'part1') return s[field] || [];
    return [];
  };
  const _p2 = (field, fallback) => {
    if (s.type === 'mock') return s.part2?.[field] ?? fallback;
    if (s.type === 'part2') return s[field] ?? fallback;
    return fallback;
  };

  const p1Qs = _p('questions');
  const p1Trans = _p('transcripts');
  const p1Analyses = _p('analyses');
  const p1Samples = _p('sample_answers');

  if (p1Qs.length > 0) {
    md += `## IELTS Speaking Part 1\nDate: ${now}\n\n`;
    p1Qs.forEach((q, i) => {
      md += `### Q${i + 1}\n`;
      md += `**Q:** ${q}\n`;
      md += `**My Answer:** ${p1Trans[i] || '—'}\n`;
      if (p1Samples[i]) md += `**Sample Answer:** ${p1Samples[i]}\n`;
      md += buildAnalysisMarkdown(p1Analyses[i] || {});
      md += '\n';
    });
  }

  const p2Topic = _p2('topic', '');
  const p2Transcript = _p2('transcript', '');
  const p2Analysis = _p2('analysis', {});
  const p2Sample = _p2('sample_answer', '');

  if (p2Topic) {
    md += `## IELTS Speaking Part 2 & 3\nDate: ${now}\n\n`;
    md += `### Topic Card\n${p2Topic}\n\n`;
    md += `### Part 2 — My Response\n${p2Transcript || '—'}\n`;
    md += buildAnalysisMarkdown(p2Analysis);
    if (p2Sample) md += `\n### Sample Answer\n${p2Sample}\n`;

    const p3 = s.part3 || {};
    const p3Qs = p3.questions || [];
    const p3Trans = p3.transcripts || [];
    const p3Analyses = p3.analyses || [];
    const p3Samples = p3.sample_answers || [];

    if (p3Qs.length > 0) {
      md += `\n### Part 3 — Discussion\n\n`;
      p3Qs.forEach((q, i) => {
        md += `#### Q${i + 1}\n`;
        md += `**Q:** ${q}\n`;
        md += `**My Answer:** ${p3Trans[i] || '—'}\n`;
        if (p3Samples[i]) md += `**Sample Answer:** ${p3Samples[i]}\n`;
        md += buildAnalysisMarkdown(p3Analyses[i] || {});
        md += '\n';
      });
    }
  }

  md += `---\n\nPlease analyze my responses for:\n`;
  md += `1. Fluency and coherence\n`;
  md += `2. Lexical resource (vocabulary range)\n`;
  md += `3. Grammatical range and accuracy\n`;
  md += `4. Compare my answer with the sample answer and identify gaps\n`;
  md += `5. Estimated band score\n`;
  md += `6. Specific suggestions for improvement\n`;
  md += `\n**以 IELTS Band 7 為標準，請針對每個回答：**\n`;
  md += `- 逐句標出文法錯誤、用詞不當、搭配不自然之處，並提供修正後的句子\n`;
  md += `- 指出哪些表達過於簡單或重複，建議替換為 Band 7 水準的詞彙/片語\n`;
  md += `- 若回答缺乏連貫性或篇章標記，示範如何加入適當的 discourse markers\n`;
  md += `- 提供一段修正後的完整回答範例（Band 7 版本），方便我對照學習\n`;
  return md;
}

async function copyHistoryDetail() {
  const md = buildHistoryMarkdown(_historyDetailSession);
  if (!md) return;
  try {
    await navigator.clipboard.writeText(md);
    const toast = $('#history-copy-toast');
    if (toast) { toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2000); }
  } catch {
    const ta = document.createElement('textarea');
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

// ---------------------------------------------------------------------------
// Question Bank
// ---------------------------------------------------------------------------
async function loadBank() {
  try {
    const res = await fetch('/api/questions');
    const data = await res.json();
    $('#bank-part1').value = (data.part1 || []).join('\n');
    $('#bank-part2').value = (data.part2 || []).join('\n---\n');
    updateBankCounts(data);
  } catch {
    // empty bank
  }
}

function updateBankCounts(data) {
  $('#bank-part1-count').textContent = `(${(data.part1 || []).length})`;
  $('#bank-part2-count').textContent = `(${(data.part2 || []).length})`;
}

async function saveBank() {
  const part1 = $('#bank-part1')
    .value.split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const part2 = $('#bank-part2')
    .value.split('\n---\n')
    .map((t) => t.trim())
    .filter(Boolean);

  const data = { part1, part2 };

  try {
    await fetch('/api/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    updateBankCounts(data);
    alert('Question bank saved!');
  } catch {
    alert('Failed to save question bank.');
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Transcript highlighting — fillers (red), discourse (green), complex (blue)
// ---------------------------------------------------------------------------
const _HL_FILLER_WORDS = new Set([
  'um', 'uh', 'er', 'ah', 'hmm', 'like', 'basically', 'actually', 'literally',
]);
const _HL_FILLER_PHRASES = ['you know', 'i mean', 'kind of', 'sort of'];

const _HL_DISCOURSE_WORDS = new Set([
  'however', 'moreover', 'furthermore', 'therefore', 'consequently',
  'nevertheless', 'besides', 'meanwhile', 'similarly', 'indeed',
  'certainly', 'obviously', 'clearly', 'fortunately', 'unfortunately',
  'honestly', 'personally', 'interestingly', 'surprisingly',
]);
const _HL_DISCOURSE_PHRASES = [
  'in addition', 'on the other hand', 'as a result', 'for example',
  'for instance', 'in contrast', 'in fact', 'as well', 'not only',
  'on top of that', 'apart from', 'in general', 'to be honest',
  'in my opinion', 'from my perspective',
];

const _HL_COMPLEX_WORDS = new Set([
  'although', 'because', 'since', 'while', 'whereas',
  'if', 'when', 'unless', 'whether', 'which', 'who', 'whom',
]);

function highlightTranscript(text) {
  if (!text || text.startsWith('(')) return escapeHtml(text);

  const lower = text.toLowerCase();

  // Phase 1: find multi-word phrase positions (case-insensitive)
  const phraseMarks = [];
  for (const phrase of _HL_FILLER_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      phraseMarks.push({ start: idx, end: idx + phrase.length, cls: 'hl-filler' });
      idx = lower.indexOf(phrase, idx + 1);
    }
  }
  for (const phrase of _HL_DISCOURSE_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      phraseMarks.push({ start: idx, end: idx + phrase.length, cls: 'hl-discourse' });
      idx = lower.indexOf(phrase, idx + 1);
    }
  }
  phraseMarks.sort((a, b) => a.start - b.start);

  // Phase 2: deduplicate overlapping phrases, mark covered char ranges
  const covered = new Array(text.length).fill(false);
  const phraseSpans = [];
  for (const pm of phraseMarks) {
    let overlap = false;
    for (let i = pm.start; i < pm.end; i++) {
      if (covered[i]) { overlap = true; break; }
    }
    if (!overlap) {
      for (let i = pm.start; i < pm.end; i++) covered[i] = true;
      phraseSpans.push(pm);
    }
  }

  // Phase 3: tokenize preserving whitespace
  const parts = [];
  const tokenRe = /(\S+|\s+)/g;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    parts.push({ text: m[0], start: m.index });
  }

  // Phase 4: build highlighted HTML — phrases as whole spans, single words classified
  let result = '';
  for (const part of parts) {
    const pStart = part.start;
    const pEnd = pStart + part.text.length;

    const phraseHit = phraseSpans.find(
      (ps) => pStart >= ps.start && pEnd <= ps.end,
    );
    if (phraseHit) {
      const isFirst = parts.findIndex(
        (p) => p.start >= phraseHit.start && p.start + p.text.length <= phraseHit.end && p.text.trim(),
      ) === parts.indexOf(part);
      if (isFirst) {
        const phraseText = text.slice(phraseHit.start, phraseHit.end);
        result += `<span class="${phraseHit.cls}">${escapeHtml(phraseText)}</span>`;
      }
      continue;
    }

    if (covered[pStart]) continue;

    const word = part.text.trim().toLowerCase().replace(/[.,!?;:'"()]/g, '');
    if (!word || !part.text.trim()) {
      result += escapeHtml(part.text);
      continue;
    }

    if (_HL_COMPLEX_WORDS.has(word)) {
      result += `<span class="hl-complex">${escapeHtml(part.text)}</span>`;
    } else if (_HL_DISCOURSE_WORDS.has(word)) {
      result += `<span class="hl-discourse">${escapeHtml(part.text)}</span>`;
    } else if (_HL_FILLER_WORDS.has(word)) {
      result += `<span class="hl-filler">${escapeHtml(part.text)}</span>`;
    } else {
      result += escapeHtml(part.text);
    }
  }

  return result;
}
