import { describe, expect, it } from "vitest";
import { collectPlanMediaIds, filterPlanMedia, parseTradingViewUrl, sniffImageMime } from "../planMedia";

describe("parseTradingViewUrl", () => {
  it("maps snapshot links to the s3 image (first letter of the id, lowercase)", () => {
    expect(parseTradingViewUrl("https://www.tradingview.com/x/AbCd1234/")).toEqual({
      kind: "snapshot",
      url: "https://www.tradingview.com/x/AbCd1234/",
      id: "AbCd1234",
      imageUrl: "https://s3.tradingview.com/snapshots/a/AbCd1234.png",
    });
    expect(parseTradingViewUrl("  https://ru.tradingview.com/x/Zq9kLm0P  ")).toMatchObject({
      kind: "snapshot",
      imageUrl: "https://s3.tradingview.com/snapshots/z/Zq9kLm0P.png",
    });
  });

  it("reads the symbol from chart and symbols links", () => {
    expect(parseTradingViewUrl("https://www.tradingview.com/chart/?symbol=NASDAQ%3ANVDA")).toMatchObject({
      kind: "chart",
      symbol: "NVDA",
      exchange: "NASDAQ",
    });
    expect(parseTradingViewUrl("https://www.tradingview.com/chart/aB3dE5fG/?symbol=AMEX:SPY")).toMatchObject({ symbol: "SPY", exchange: "AMEX" });
    expect(parseTradingViewUrl("https://www.tradingview.com/symbols/NASDAQ-AAPL/")).toMatchObject({ kind: "chart", symbol: "AAPL", exchange: "NASDAQ" });
    expect(parseTradingViewUrl("https://www.tradingview.com/chart/TSLA/Xy12Ab34-breakout/")).toMatchObject({ kind: "chart", symbol: "TSLA" });
    expect(parseTradingViewUrl("https://www.tradingview.com/chart/aB3dE5fG/")).toMatchObject({ kind: "chart", symbol: null });
  });

  it("rejects non-TradingView, insecure and spoofed hosts", () => {
    expect(parseTradingViewUrl("http://www.tradingview.com/x/AbCd1234/")).toBeNull();
    expect(parseTradingViewUrl("https://tradingview.com.evil.io/x/AbCd1234/")).toBeNull();
    expect(parseTradingViewUrl("https://eviltradingview.com/x/AbCd1234/")).toBeNull();
    expect(parseTradingViewUrl("javascript:alert(1)")).toBeNull();
    expect(parseTradingViewUrl("https://user:pw@www.tradingview.com/x/AbCd1234/")).toBeNull();
    expect(parseTradingViewUrl("")).toBeNull();
  });

  it("keeps other TradingView pages as plain links", () => {
    expect(parseTradingViewUrl("https://www.tradingview.com/ideas/")).toMatchObject({ kind: "other" });
  });
});

describe("plan media helpers", () => {
  it("sniffs image types from magic bytes", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe("image/png");
    expect(sniffImageMime(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP")]))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("<svg onload=alert(1)></svg>"))).toBeNull();
  });

  it("collects and filters refs at plan and ticker level", () => {
    const doc = {
      media: [{ id: 1, caption: "a" }, { id: 2, caption: "" }],
      inPlay: [{ media: [{ id: 2, caption: "" }, { id: 3, caption: "c" }] }, { media: [] }],
    };
    expect(collectPlanMediaIds(doc).sort()).toEqual([1, 2, 3]);
    const out = filterPlanMedia(doc, new Set([1, 3]));
    expect(out.media.map((m) => m.id)).toEqual([1]);
    expect(out.inPlay[0]!.media.map((m) => m.id)).toEqual([3]);
  });
});
