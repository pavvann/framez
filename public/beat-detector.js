class BeatDetectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._prevRms = 0;
    this._avgRms = 0;
    this._cooldown = 0;
    this._fluxThreshold = 0.05;
    this._rmsMultiplier = 1.5;

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

      // RMS of this 128-sample block
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sum / samples.length);

      // flux = positive rise only — catches onset, not sustained energy
      const flux = Math.max(0, rms - this._prevRms);
      this._prevRms = rms;
      this._avgRms = this._avgRms * 0.88 + rms * 0.12;

      if (this._cooldown > 0) {
        this._cooldown--;
      } else if (flux > this._fluxThreshold && rms > this._avgRms * this._rmsMultiplier) {
        // high flux threshold + must be louder than recent average
        // cooldown: 20 blocks * 128 / 44100 ≈ 58ms (filters out snares/hats that follow kicks)
        this._cooldown = 20;
        this.port.postMessage({ type: 'kick' });
      }
    }

    return true;
  }
}

registerProcessor('beat-detector', BeatDetectorProcessor);
