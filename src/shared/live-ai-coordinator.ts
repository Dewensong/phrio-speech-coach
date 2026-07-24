export interface LiveHintPolicy {
  readonly minimumNewFinalCharacters: number;
  readonly debounceMs: number;
  readonly cooldownMs: number;
  readonly maximumRequests: number;
  readonly maximumWindowCharacters: number;
  readonly timeoutMs: number;
}

export interface LiveHintRequest {
  readonly attemptId: string;
  readonly generation: number;
  readonly requestSequence: number;
  readonly finalTextWindow: string;
  readonly signal: AbortSignal;
}

export interface LiveHintResult {
  readonly requestSequence: number;
  readonly text: string;
  readonly stale: boolean;
  readonly reason: 'accepted' | 'duplicate' | 'disabled' | 'late' | 'timeout' | 'failed';
}

type LiveHintAbortReason = 'disabled' | 'superseded' | 'timeout';

type LiveHintRequestOutcome =
  | { readonly type: 'resolved'; readonly text: string }
  | { readonly type: 'aborted'; readonly reason: LiveHintAbortReason }
  | { readonly type: 'failed' };

function abortReason(signal: AbortSignal): LiveHintAbortReason {
  return signal.reason === 'timeout'
    ? 'timeout'
    : signal.reason === 'disabled'
      ? 'disabled'
      : 'superseded';
}

export const DEFAULT_LIVE_HINT_POLICY: LiveHintPolicy = Object.freeze({
  minimumNewFinalCharacters: 30,
  debounceMs: 700,
  cooldownMs: 4_000,
  maximumRequests: 8,
  maximumWindowCharacters: 360,
  timeoutMs: 6_000,
});

/** Request topology only; payload consent and network transport remain injected boundaries. */
export class LiveHintCoordinator {
  readonly #attemptId: string;
  readonly #generation: number;
  readonly #policy: LiveHintPolicy;
  readonly #request: (request: LiveHintRequest) => Promise<string>;
  readonly #onResult: (result: LiveHintResult) => void;
  #enabled = true;
  #finalText = '';
  #sentLength = 0;
  #requestCount = 0;
  #requestSequence = 0;
  #latestAcceptedSequence = 0;
  #lastRequestAt = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #abort: AbortController | null = null;
  #seenHints = new Set<string>();

  constructor(input: {
    readonly attemptId: string;
    readonly generation: number;
    readonly policy?: LiveHintPolicy;
    readonly request: (request: LiveHintRequest) => Promise<string>;
    readonly onResult: (result: LiveHintResult) => void;
  }) {
    this.#attemptId = input.attemptId;
    this.#generation = input.generation;
    this.#policy = input.policy ?? DEFAULT_LIVE_HINT_POLICY;
    this.#request = input.request;
    this.#onResult = input.onResult;
  }

  appendFinal(text: string, now = Date.now()): void {
    if (!this.#enabled || !text.trim()) return;
    this.#finalText += text.trim();
    if (
      this.#finalText.length - this.#sentLength < this.#policy.minimumNewFinalCharacters ||
      this.#requestCount >= this.#policy.maximumRequests
    ) return;
    if (this.#timer) clearTimeout(this.#timer);
    const cooldownRemaining = Math.max(0, this.#policy.cooldownMs - (now - this.#lastRequestAt));
    this.#timer = setTimeout(() => void this.#dispatch(), Math.max(this.#policy.debounceMs, cooldownRemaining));
  }

  disable(): void {
    this.#enabled = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort?.abort('disabled');
    this.#abort = null;
  }

  enable(): void {
    this.#enabled = true;
  }

  async #dispatch(): Promise<void> {
    this.#timer = null;
    if (!this.#enabled || this.#requestCount >= this.#policy.maximumRequests) return;
    this.#requestCount += 1;
    this.#requestSequence += 1;
    const sequence = this.#requestSequence;
    const window = this.#finalText.slice(-this.#policy.maximumWindowCharacters);
    this.#sentLength = this.#finalText.length;
    this.#lastRequestAt = Date.now();
    this.#abort?.abort('superseded');
    const controller = new AbortController();
    this.#abort = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), this.#policy.timeoutMs);
    try {
      const aborted = new Promise<LiveHintRequestOutcome>((resolve) => {
        controller.signal.addEventListener(
          'abort',
          () => resolve({ type: 'aborted', reason: abortReason(controller.signal) }),
          { once: true },
        );
      });
      const requested = Promise.resolve()
        .then(() => this.#request({
          attemptId: this.#attemptId,
          generation: this.#generation,
          requestSequence: sequence,
          finalTextWindow: window,
          signal: controller.signal,
        }))
        .then(
          (text): LiveHintRequestOutcome => ({ type: 'resolved', text }),
          (): LiveHintRequestOutcome => controller.signal.aborted
            ? { type: 'aborted', reason: abortReason(controller.signal) }
            : { type: 'failed' },
        );
      const outcome = await Promise.race([requested, aborted]);
      if (outcome.type === 'aborted') {
        this.#onResult({
          requestSequence: sequence,
          text: '',
          stale: true,
          reason: outcome.reason === 'superseded' ? 'late' : outcome.reason,
        });
        return;
      }
      if (outcome.type === 'failed') {
        this.#onResult({ requestSequence: sequence, text: '', stale: true, reason: 'failed' });
        return;
      }
      const text = outcome.text.trim();
      if (!this.#enabled) {
        this.#onResult({ requestSequence: sequence, text, stale: true, reason: 'disabled' });
        return;
      }
      if (controller.signal.aborted) {
        const reason = abortReason(controller.signal);
        this.#onResult({
          requestSequence: sequence,
          text: '',
          stale: true,
          reason: reason === 'superseded' ? 'late' : reason,
        });
        return;
      }
      if (sequence < this.#requestSequence || sequence < this.#latestAcceptedSequence) {
        this.#onResult({ requestSequence: sequence, text, stale: true, reason: 'late' });
        return;
      }
      const fingerprint = text.replace(/\s+/g, '').toLocaleLowerCase();
      if (this.#seenHints.has(fingerprint)) {
        this.#onResult({ requestSequence: sequence, text, stale: true, reason: 'duplicate' });
        return;
      }
      this.#seenHints.add(fingerprint);
      this.#latestAcceptedSequence = sequence;
      this.#onResult({ requestSequence: sequence, text, stale: false, reason: 'accepted' });
    } finally {
      clearTimeout(timeout);
      if (this.#abort === controller) this.#abort = null;
    }
  }
}

export class DeepReportCoordinator<Result> {
  readonly #generate: (signal: AbortSignal) => Promise<Result>;
  #controller: AbortController | null = null;

  constructor(generate: (signal: AbortSignal) => Promise<Result>) {
    this.#generate = generate;
  }

  /** Returns immediately with a task handle; recording/local work never awaits this method. */
  enqueue(): { readonly status: 'queued'; readonly task: Promise<Result> } {
    this.#controller?.abort();
    this.#controller = new AbortController();
    return { status: 'queued', task: this.#generate(this.#controller.signal) };
  }

  cancel(): void {
    this.#controller?.abort();
    this.#controller = null;
  }
}
