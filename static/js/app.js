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

  // Part 1  — each entry: { id, question, answer }
  part1Parsed: [],
  part1Questions: [],
  part1Answers: [],
  part1Index: 0,
  part1Recordings: [],
  part1Transcripts: [],
  part1Timer: null,

  // Part 2
  part2Topic: '',
  part2Notes: '',
  part2Recording: null,
  part2Transcript: null,
  part2NotesTimer: null,
  part2SpeakTimer: null,

  // Part 3
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

// ---------------------------------------------------------------------------
// Routing — event delegation
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const handlers = {
    'goto-home':        () => showScreen('home'),
    'goto-part1-setup': () => { showScreen('part1-setup'); autoLoadFile(); },
    'goto-part2-setup': () => { showScreen('part2-setup'); autoLoadFilePart2(); },
    'goto-bank':        () => { loadBank(); showScreen('bank'); },
    'load-file-part1':  loadFilePart1,
    'random-part1':     randomPart1,
    'start-part1':      startPart1,
    'skip-part1':       () => advancePart1(),
    'random-part2':     randomPart2,
    'start-part2':      startPart2,
    'skip-part3':       () => advancePart3(),
    'copy-results':     copyResults,
    'save-bank':        saveBank,
    'reset-drawn':      resetDrawnHistory,
    'reshuffle-part1':  loadFilePart1,
    'reset-drawn-part2':  resetDrawnHistoryPart2,
    'reshuffle-part2':    loadFilePart2,
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
    summaryExtra += ` · <span class="drawn-status">${drawnInfo.remaining} remaining / ${drawnInfo.total} total</span>`;
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

// Part 2 file-loaded state
let _fileAnswersPart2 = {};
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
    let undrawn = parsed.filter((p) => !drawnSet.has(p.id));

    // If all questions have been drawn, show reset prompt
    if (undrawn.length === 0 && parsed.length > 0) {
      _showAllDrawnStatus(parsed.length);
      undrawn = parsed; // fallback: show all for manual pick
    }

    // Randomly select up to 5 undrawn questions
    const selected = _shuffle(undrawn).slice(0, 5);

    const questionsOnly = selected
      .map((p) => `# Q${p.id}:\n${p.question}`)
      .join('\n\n');
    $('#part1-md-input').value = questionsOnly;

    const drawnInfo = {
      remaining: parsed.filter((p) => !drawnSet.has(p.id)).length,
      total: parsed.length,
    };
    renderParsedPreview(parseQuestionsMarkdown(questionsOnly), drawnInfo);
  } catch {
    // file not found — silent
  }
}

function _showAllDrawnStatus(total) {
  const el = $('#part1-drawn-status');
  if (!el) return;
  el.innerHTML =
    `<div class="drawn-all-done">All ${total} questions have been practiced! ` +
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
// Part 1 — Practice flow
// ---------------------------------------------------------------------------
async function startPart1() {
  const parsed = parseQuestionsMarkdown($('#part1-md-input').value);
  if (parsed.length === 0) {
    alert('No questions found. Use the # Qx-y: format.');
    return;
  }

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

function runPart1Question() {
  const idx = state.part1Index;
  const total = state.part1Questions.length;
  const q = state.part1Questions[idx];

  // Update UI
  $('#part1-counter').textContent = `Q${idx + 1} / ${total}`;
  $('#part1-question-text').textContent = q;
  $('#part1-rec-badge').classList.add('active');

  // Start recording
  state.recorder.start();

  // Start timer
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
  // Stop current timer & recording
  if (state.part1Timer) state.part1Timer.stop();
  $('#part1-rec-badge').classList.remove('active');

  let blob;
  try {
    blob = await state.recorder.stop();
  } catch {
    blob = new Blob([], { type: 'audio/webm' });
  }
  state.part1Recordings.push(blob);

  state.part1Index++;

  if (state.part1Index < state.part1Questions.length) {
    // Reset timer ring for next question
    state.part1Timer.reset(45);
    runPart1Question();
  } else {
    // All done — transcribe
    finishPart1();
  }
}

async function finishPart1() {
  showScreen('processing');
  $('#processing-status').textContent = 'Transcribing audio… this may take a moment';

  // Transcribe all in parallel
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
  await markDrawn(practicedIds);

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

  state.part2Topic = topic;
  state.part2Notes = '';
  state.part2Recording = null;
  state.part2Transcript = null;
  state.sessionId = generateSessionId();

  // Show topic on notes screen
  $('#part2-topic-display').textContent = topic;
  $('#part2-notes-area').value = '';

  showScreen('part2-notes');

  // Start 2-minute notes timer
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
  // Save notes
  state.part2Notes = $('#part2-notes-area').value.trim();

  // Init recorder if needed
  try {
    await state.recorder.init();
  } catch {
    alert('Microphone access denied.');
    showScreen('home');
    return;
  }

  // Setup speaking screen
  $('#part2-topic-display-2').textContent = state.part2Topic;
  $('#part2-notes-reminder').textContent = state.part2Notes || '(no notes)';
  $('#part2-rec-badge').classList.add('active');

  showScreen('part2-speaking');

  // Start recording
  state.recorder.start();

  // Start 2-minute speaking timer
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
  const data = {
    session_id: state.sessionId,
    type: 'part2',
    created_at: new Date().toISOString(),
    topic: state.part2Topic,
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
    };
  }

  await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {});
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

function runPart3Question() {
  const idx = state.part3Index;
  const total = state.part3Questions.length;
  const q = state.part3Questions[idx];

  $('#part3-counter').textContent = `Q${idx + 1} / ${total}`;
  $('#part3-question-text').textContent = q;
  $('#part3-rec-badge').classList.add('active');

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
  if (state.part3Timer) state.part3Timer.stop();
  $('#part3-rec-badge').classList.remove('active');

  let blob;
  try {
    blob = await state.recorder.stop();
  } catch {
    blob = new Blob([], { type: 'audio/webm' });
  }
  state.part3Recordings.push(blob);

  state.part3Index++;

  if (state.part3Index < state.part3Questions.length) {
    state.part3Timer.reset(60);
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
    </div>
    <div class="band-disclaimer">* Estimated from transcript only (pronunciation not assessed)</div>`;
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
    </div>`;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function renderResults() {
  const container = $('#results-content');
  container.innerHTML = '';

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
          <div class="transcript-text">${escapeHtml(t.transcript || '—')}</div>
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
        <div class="transcript-text">${escapeHtml(t.transcript || '—')}</div>
        <div class="duration-text">Duration: ${t.duration || 0}s</div>
        ${blobUrl ? `<audio controls src="${blobUrl}"></audio>` : ''}
        ${buildAnalysisHtml(t.analysis)}
        ${sampleHtml}
      </div>`;

    if (state.part3Transcripts.length > 0) {
      state.part3Questions.forEach((q, i) => {
        const p3t = state.part3Transcripts[i] || {};
        const p3Label = state.part3Parsed[i]?.id || `${i + 1}`;
        const p3BlobUrl = state.part3Recordings[i]
          ? URL.createObjectURL(state.part3Recordings[i])
          : null;

        container.innerHTML += `
          <div class="result-card">
            <h4>Part 3 — Q${escapeHtml(p3Label)}</h4>
            <div class="question-text">${escapeHtml(q)}</div>
            <div class="transcript-text">${escapeHtml(p3t.transcript || '—')}</div>
            <div class="duration-text">Duration: ${p3t.duration || 0}s</div>
            ${p3BlobUrl ? `<audio controls src="${p3BlobUrl}"></audio>` : ''}
            ${buildAnalysisHtml(p3t.analysis)}
          </div>`;
      });
    }
  }

  showScreen('results');
}

function buildAnalysisMarkdown(a) {
  if (!a || !a.word_count) return '';
  let s = '';
  if (a.band) {
    s += `**Estimated Band:** Overall ${a.band.overall} · `;
    s += `FC ${a.band.fluency_coherence} · LR ${a.band.lexical_resource} · GRA ${a.band.grammatical_range}`;
    s += ` *(transcript-based estimate, pronunciation not assessed)*\n`;
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
  let md = '';

  if (state.part1Transcripts.length > 0) {
    md += `## IELTS Speaking Part 1 Practice\nDate: ${now}\n\n`;
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
  }

  if (state.part2Transcript) {
    const p2Sample = _currentPart2Id ? (_fileAnswersPart2[_currentPart2Id] || '') : '';
    md += `## IELTS Speaking Part 2 & 3 Practice\nDate: ${now}\n\n`;
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
        md += `#### Q${p3Label}\n`;
        md += `**Q:** ${q}\n`;
        md += `**My Answer:** ${p3t.transcript || '—'}\n`;
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
  }

  return md;
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
