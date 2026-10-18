import { describe, expect, it } from "vitest";
import { extractTradingViewUrls, parseTradingViewUrl } from "./tradingview";

describe("parseTradingViewUrl (client)", () => {
  it("snapshot → s3 image with the lowercase first letter of the id", () => {
    expect(parseTradingViewUrl("https://www.tradingview.com/x/AbCd1234/")).toEqual({
      kind: "snapshot",
      url: "https://www.tradingview.com/x/AbCd1234/",
      id: "AbCd1234",
      imageUrl: "https://s3.tradingview.com/snapshots/a/AbCd1234.png",
    });
    expect(parseTradingViewUrl("https://tradingview.com/x/QWErty12")).toMatchObject({
      imageUrl: "https://s3.tradingview.com/snapshots/q/QWErty12.png",
    });
  });

  it("chart and symbols links carry the ticker", () => {
    expect(parseTradingViewUrl("https://www.tradingview.com/chart/?symbol=NASDAQ:NVDA")).toMatchObject({ kind: "chart", symbol: "NVDA", exchange: "NASDAQ" });
    expect(parseTradingViewUrl("https://www.tradingview.com/symbols/NYSE-BA/")).toMatchObject({ symbol: "BA", exchange: "NYSE" });
    expect(parseTradingViewUrl("https://www.tradingview.com/chart/AMD/Ab12Cd34-gap-fill/")).toMatchObject({ symbol: "AMD" });
    expect(parseTradingViewUrl("https://www.tradingview.com/chart/kLm9Pq2R/")).toMatchObject({ kind: "chart", symbol: null });
  });

  it("rejects anything that is not https on tradingview.com", () => {
    for (const bad of [
      "http://www.tradingview.com/x/AbCd1234/",
      "https://tradingview.com.attacker.net/x/AbCd1234/",
      "https://faketradingview.com/x/AbCd1234/",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "not a url",
    ]) {
      expect(parseTradingViewUrl(bad)).toBeNull();
    }
  });

  it("extracts several links from pasted text", () => {
    expect(
      extractTradingViewUrls("NVDA https://www.tradingview.com/x/AbCd1234/, and https://example.com/x.png https://www.tradingview.com/symbols/NASDAQ-AAPL/"),
    ).toEqual(["https://www.tradingview.com/x/AbCd1234/", "https://www.tradingview.com/symbols/NASDAQ-AAPL/"]);
  });
});
