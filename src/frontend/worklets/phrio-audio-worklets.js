// 1,024 frames cap the primary 16 kHz capture path at 64 ms. The deprecated
// ScriptProcessor compatibility path intentionally remains at 2,048 frames to
// avoid doubling main-thread callbacks on older Electron audio stacks.
const PCM_CAPTURE_BLOCK_FRAMES = 1024;

class PhrioPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sequence = 0;
    this.frameCount = 0;
    this.pending = new Float32Array(PCM_CAPTURE_BLOCK_FRAMES);
    this.pendingLength = 0;
    this.flushed = false;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message || message.type !== 'flush' || this.flushed) return;
      this.flushed = true;
      this.emitPending();
      this.port.postMessage({
        type: 'flushed',
        requestId: message.requestId,
        sequence: this.sequence,
        frameCount: this.frameCount,
      });
    };
  }

  emitPending() {
    if (this.pendingLength === 0) return;
    const samples = this.pending.slice(0, this.pendingLength);
    this.pendingLength = 0;
    this.frameCount += samples.length;
    this.port.postMessage({
      type: 'pcm',
      sequence: this.sequence,
      frameCount: this.frameCount,
      samples,
    }, [samples.buffer]);
    this.sequence += 1;
  }

  process(inputs) {
    if (this.flushed) return true;
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;
    const frameLength = channels[0].length;
    let offset = 0;
    while (offset < frameLength) {
      const writable = Math.min(this.pending.length - this.pendingLength, frameLength - offset);
      for (let frame = 0; frame < writable; frame += 1) {
        let mixed = 0;
        for (let channel = 0; channel < channels.length; channel += 1) {
          mixed += channels[channel][offset + frame] || 0;
        }
        this.pending[this.pendingLength + frame] = mixed / channels.length;
      }
      this.pendingLength += writable;
      offset += writable;
      if (this.pendingLength === this.pending.length) this.emitPending();
    }
    return true;
  }
}

class PhrioMicrophoneCheckProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;
    let squareSum = 0;
    let peak = 0;
    const frames = channels[0].length;
    for (let frame = 0; frame < frames; frame += 1) {
      let mixed = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        mixed += channels[channel][frame] || 0;
      }
      mixed /= channels.length;
      const magnitude = Math.abs(mixed);
      peak = Math.max(peak, magnitude);
      squareSum += mixed * mixed;
    }
    this.port.postMessage({ type: 'metrics', frames, squareSum, peak });
    return true;
  }
}

registerProcessor('phrio-pcm-capture', PhrioPcmCaptureProcessor);
registerProcessor('phrio-microphone-check', PhrioMicrophoneCheckProcessor);
