/**
 * Countdown timer with SVG ring progress.
 *
 * Usage:
 *   const t = new Timer(45, ringEl, textEl, { onTick, onComplete, onWarning });
 *   t.start();
 */
export class Timer {
  /** @param {number} totalSeconds */
  constructor(totalSeconds, ringEl, textEl, { onTick, onComplete, onWarning } = {}) {
    this.total = totalSeconds;
    this.remaining = totalSeconds;
    this.ringEl = ringEl;
    this.textEl = textEl;
    this.onTick = onTick ?? (() => {});
    this.onComplete = onComplete ?? (() => {});
    this.onWarning = onWarning ?? (() => {});
    this._interval = null;

    // SVG ring setup — circumference of r=52 circle
    this.circumference = 2 * Math.PI * 52; // ≈ 326.73
    if (this.ringEl) {
      this.ringEl.style.strokeDasharray = this.circumference;
      this.ringEl.style.strokeDashoffset = 0;
    }
    this._render();
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this._tick(), 1000);
  }

  stop() {
    clearInterval(this._interval);
    this._interval = null;
  }

  reset(newTotal) {
    this.stop();
    if (newTotal !== undefined) this.total = newTotal;
    this.remaining = this.total;
    this._render();
  }

  _tick() {
    this.remaining--;
    this._render();
    this.onTick(this.remaining);

    if (this.remaining <= 5 && this.remaining > 0) {
      this.onWarning(this.remaining);
    }

    if (this.remaining <= 0) {
      this.stop();
      this.onComplete();
    }
  }

  _render() {
    // Update text
    if (this.textEl) {
      if (this.total >= 60) {
        const m = Math.floor(this.remaining / 60);
        const s = this.remaining % 60;
        this.textEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
      } else {
        this.textEl.textContent = this.remaining;
      }
    }

    // Update ring progress
    if (this.ringEl) {
      const fraction = 1 - this.remaining / this.total;
      this.ringEl.style.strokeDashoffset = this.circumference * fraction;

      // Color shifts: green → yellow → red
      if (this.remaining <= 5) {
        this.ringEl.classList.add('danger');
        this.ringEl.classList.remove('warning');
      } else if (this.remaining <= 10) {
        this.ringEl.classList.add('warning');
        this.ringEl.classList.remove('danger');
      } else {
        this.ringEl.classList.remove('warning', 'danger');
      }
    }
  }
}

/**
 * Play a short beep via Web Audio API (no files needed).
 */
export function playBeep(frequency = 800, duration = 150) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = frequency;
    gain.gain.value = 0.3;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, duration);
  } catch {
    // Audio context unavailable — silent fallback
  }
}
