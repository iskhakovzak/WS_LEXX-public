import { describe, expect, it } from "vitest";
import { csvText } from "./csv";

describe("csvText", () => {
  it("joins with ; and CRLF behind a BOM", () => {
    expect(csvText([["a", "b"], [1, 2]])).toBe("﻿a;b\r\n1;2");
  });
  it("rounds numbers to 4 decimals and leaves empty cells for null / NaN", () => {
    expect(csvText([[1.234567, null, undefined, Number.NaN, 0]])).toBe("﻿1.2346;;;;0");
  });
  it("quotes cells with separators, quotes or line breaks", () => {
    expect(csvText([["a;b", 'say "hi"', "x\ny"]])).toBe('﻿"a;b";"say ""hi""";"x\ny"');
  });
});
