// Realtime session configuration shared by the browser flow and the voice eval.
import { TOOLS, buildInstructions } from './agent.js';

export const config = () => ({
  model: process.env.REALTIME_MODEL || 'gpt-realtime-2.1-mini',
  voice: process.env.REALTIME_VOICE || 'marin',
  transcribeModel: process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  // semantic_vad waits for the user to sound finished, so mid-sentence pauses
  // ("from the fifth… to the sixth") do not trigger an answer.
  vad: process.env.VAD_TYPE || 'semantic_vad',
  eagerness: process.env.VAD_EAGERNESS || 'medium',
});

export function sessionConfig({ forWebSocket = false } = {}) {
  const c = config();
  const turn_detection = c.vad === 'semantic_vad'
    ? { type: 'semantic_vad', eagerness: c.eagerness, create_response: true, interrupt_response: true }
    : { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true };

  const input = {
    transcription: { model: c.transcribeModel, language: 'en' },
    turn_detection,
    noise_reduction: { type: 'near_field' },
  };
  const output = { voice: c.voice };
  if (forWebSocket) {
    // The eval streams raw 24 kHz mono PCM16 over a WebSocket.
    input.format = { type: 'audio/pcm', rate: 24000 };
    output.format = { type: 'audio/pcm', rate: 24000 };
  }
  return {
    type: 'realtime',
    model: c.model,
    instructions: buildInstructions(),
    output_modalities: ['audio'],
    audio: { input, output },
    tools: TOOLS,
    tool_choice: 'auto',
  };
}
