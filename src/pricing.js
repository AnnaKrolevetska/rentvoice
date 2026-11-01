// Pricing assumptions (USD per 1M tokens unless noted).
// Source: OpenAI API pricing page (developers.openai.com/api/docs/pricing),
// rates as listed in October 2026. Re-check before quoting; they change.
export const PRICING_SOURCE = 'OpenAI API pricing page, rates listed Oct 2026 (USD)';

export const REALTIME_PRICES = {
  'gpt-realtime-2.1': {
    text: { input: 4.0, cached: 0.4, output: 24.0 },
    audio: { input: 32.0, cached: 0.4, output: 64.0 },
  },
  'gpt-realtime-2.1-mini': {
    text: { input: 0.6, cached: 0.06, output: 2.4 },
    audio: { input: 10.0, cached: 0.3, output: 20.0 },
  },
};

// Input transcription (shown in the UI transcript + test logs) is billed separately.
export const TRANSCRIPTION_PRICES = {
  // token rates; OpenAI's own estimate ≈ $0.003 per audio minute
  'gpt-4o-mini-transcribe': { input: 1.25, output: 5.0, est_per_minute: 0.003 },
  'gpt-4o-transcribe': { input: 2.5, output: 10.0, est_per_minute: 0.006 },
};

// Text-to-speech used ONLY by the eval script to synthesize the test inputs
// (one-off, not part of the per-operation cost).
export const TTS_PRICES = { 'gpt-4o-mini-tts': { input: 0.6, output_audio: 12.0 } };

const per = (tokens, rate) => ((tokens || 0) * rate) / 1e6;

/** Cost of one Realtime Response from its `response.done` usage block. */
export function realtimeResponseCost(model, usage) {
  const p = REALTIME_PRICES[model];
  if (!p || !usage) return null;
  const inD = usage.input_token_details || {};
  const cached = inD.cached_tokens_details || {};
  const outD = usage.output_token_details || {};
  // cached tokens are a SUBSET of input tokens of the same modality
  const textIn = (inD.text_tokens || 0) - (cached.text_tokens || 0);
  const audioIn = (inD.audio_tokens || 0) - (cached.audio_tokens || 0);
  const parts = {
    text_input: per(textIn, p.text.input),
    text_cached: per(cached.text_tokens, p.text.cached),
    audio_input: per(audioIn, p.audio.input),
    audio_cached: per(cached.audio_tokens, p.audio.cached),
    text_output: per(outD.text_tokens, p.text.output),
    audio_output: per(outD.audio_tokens, p.audio.output),
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total, parts };
}

/** Cost of one input transcription from its usage block (token-based when present). */
export function transcriptionCost(model, usage, audioSeconds) {
  const p = TRANSCRIPTION_PRICES[model];
  if (!p) return null;
  if (usage && usage.type === 'tokens') {
    return { total: per(usage.input_tokens, p.input) + per(usage.output_tokens, p.output), basis: 'tokens' };
  }
  if (usage && usage.type === 'duration') return { total: (usage.seconds / 60) * p.est_per_minute, basis: 'duration' };
  if (audioSeconds) return { total: (audioSeconds / 60) * p.est_per_minute, basis: 'estimate' };
  return null;
}
