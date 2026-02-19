/**
 * Browser audio recorder wrapping MediaRecorder API.
 *
 * Usage:
 *   const rec = new AudioRecorder();
 *   await rec.init();          // request mic permission once
 *   rec.start();               // begin recording
 *   const blob = await rec.stop();  // get audio blob
 */
export class AudioRecorder {
  constructor() {
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {MediaRecorder|null} */
    this.mediaRecorder = null;
    /** @type {Blob[]} */
    this._chunks = [];
    this.mimeType = '';
  }

  /**
   * Request microphone access (call once before any recording).
   * @returns {Promise<void>}
   */
  async init() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.mimeType = this._pickMimeType();
  }

  /** Start a new recording segment. */
  start() {
    if (!this.stream) throw new Error('Recorder not initialised — call init() first');
    this._chunks = [];

    const options = this.mimeType ? { mimeType: this.mimeType } : {};
    this.mediaRecorder = new MediaRecorder(this.stream, options);

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._chunks.push(e.data);
    };

    this.mediaRecorder.start();
  }

  /**
   * Stop recording and return the audio blob.
   * @returns {Promise<Blob>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        reject(new Error('Not recording'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this._chunks, {
          type: this.mimeType || 'audio/webm',
        });
        resolve(blob);
      };

      this.mediaRecorder.onerror = (e) => reject(e.error);
      this.mediaRecorder.stop();
    });
  }

  /** Release the microphone stream entirely. */
  destroy() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  /** Pick best supported MIME type for Whisper compatibility. */
  _pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }
}

/**
 * Upload an audio blob for transcription.
 * @param {Blob} blob
 * @param {string} sessionId
 * @param {string} label
 * @returns {Promise<{transcript: string, duration: number}>}
 */
export async function transcribeBlob(blob, sessionId, label) {
  const fd = new FormData();
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  fd.append('audio', blob, `${label}.${ext}`);
  fd.append('session_id', sessionId);
  fd.append('label', label);

  const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Transcription failed: ${res.status}`);
  return res.json();
}
