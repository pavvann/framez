class BeatDetectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._prevRms = 0;
    this._avgRms = 0;
    this._cooldown = 0;
    this._fluxThreshold = 0.05;
    this._rmsMultiplier = 1.5;

    // one-pole low-pass filter state — isolates kick frequencies (~150 Hz)
    // α = 2π × fc / (2π × fc + fs), fc=150Hz, fs=44100Hz ≈ 0.021
    this._lpAlpha = 0.021;
    this._lpPrev = 0;

    this.port.onmessage = (e) => {
      if (e.data.fluxThreshold !== undefined) this._fluxThreshold = e.data.fluxThreshold;
      if (e.data.rmsMultiplier !== undefined) this._rmsMultiplier = e.data.rmsMultiplier;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (input && input[0]) {
      const samples = input[0];

      // pass audio through unchanged
      for (let ch = 0; ch < output.length; ch++) {
        if (input[ch]) output[ch].set(input[ch]);
      }

      // low-pass filter then compute RMS — only bass energy triggers kicks
      const a = this._lpAlpha;
      let lpState = this._lpPrev;
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        lpState = a * samples[i] + (1 - a) * lpState;
        sum += lpState * lpState;
      }
      this._lpPrev = lpState;

      const rms = Math.sqrt(sum / samples.length);

      // flux = positive rise only — catches onset, not sustained energy
      const flux = Math.max(0, rms - this._prevRms);
      this._prevRms = rms;
      this._avgRms = this._avgRms * 0.88 + rms * 0.12;

      if (this._cooldown > 0) {
        this._cooldown--;
      } else if (flux > this._fluxThreshold && rms > this._avgRms * this._rmsMultiplier) {
        this._cooldown = 20;
        this.port.postMessage({ type: 'kick' });
      }
    }

    return true;
  }
}

registerProcessor('beat-detector', BeatDetectorProcessor);
