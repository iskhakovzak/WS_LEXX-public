import { describe, expect, it } from "vitest";
import { encodeWav } from "./audio-wav";

const str = (v: DataView, off: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(off + i)));

describe("encodeWav", () => {
  it("writes a valid 16 kHz mono PCM header", () => {
    const v = new DataView(encodeWav(new Float32Array(160), 16000));
    expect(str(v, 0, 4)).toBe("RIFF");
    expect(str(v, 8, 4)).toBe("WAVE");
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(str(v, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(320);
    expect(v.byteLength).toBe(44 + 320);
  });
  it("clamps and scales samples to int16", () => {
    const v = new DataView(encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000));
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32768);
    expect(v.getInt16(50, true)).toBe(32767);
    expect(v.getInt16(52, true)).toBe(-32768);
    expect(v.getInt16(54, true)).toBe(16383);
  });
});
