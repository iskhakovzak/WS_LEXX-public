/**
 * Voice recordings → 16 kHz mono 16-bit WAV before upload.
 *
 * Browsers record webm/opus (Chrome, Firefox) or mp4/aac (Safari). The free local Whisper server (whisper.cpp) only
 * reads WAV without ffmpeg, and 16 kHz mono is what every Whisper model consumes anyway, so we resample in the browser.
 * OpenAI accepts WAV too. ~1.9 MB per minute, so the 5-minute recorder cap stays far below the 25 MB upload limit.
 */

export const WHISPER_SAMPLE_RATE = 16_000;

/** Pure: PCM float samples (-1..1) → WAV file bytes (16-bit little-endian, mono). */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Decode any recorder blob and resample to 16 kHz mono WAV. Throws when the browser can't decode it. */
export async function recordingToWav(blob: Blob): Promise<Blob> {
  const bytes = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes);
  } finally {
    decodeCtx.close().catch(() => undefined);
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE));
  // Rendering a multi-channel buffer into a 1-channel context downmixes it.
  const offline = new OfflineAudioContext(1, frames, WHISPER_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return new Blob([encodeWav(rendered.getChannelData(0), WHISPER_SAMPLE_RATE)], { type: "audio/wav" });
}
