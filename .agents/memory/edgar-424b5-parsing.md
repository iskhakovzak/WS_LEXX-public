---
name: SEC EDGAR 424B5 parsing
description: Rules for correctly parsing ATM vs Follow-on, debt filtering, and underwriter extraction from SEC 424B4/424B5 filing HTML
---

## ATM Detection (do this BEFORE price parsing)

ATM if ANY of:
- `/at-the-market|at the market/i` in cover page (first 4000 chars)
- `"Sales Agreement" OR "Offering Agreement"` in cover AND `"Up to $"` in cover AND no `"Public Offering Price"` in cover

**Why:** ATM offerings register a shelf at "Up to $X" with no fixed price. A Follow-on that merely *references* a prior ATM program still has "Public Offering Price: $XX.XX" in the cover. Checking ATM before price parsing prevents spurious price extraction from reference market prices.

**Confirmed cases:**
- LUNR: "Sales Agreement) with Barclays Capital Inc." + "Up to $500,000,000" → ATM ✓
- ASTC: "at-the-market offering agreement...with H.C. Wainwright" → ATM ✓
- ASYS: "Public Offering Price $ 20.500" → NOT ATM → Follow-on ✓

## Debt Filtering

Skip offering if cover page (first 4000 chars) contains:
- `/convertible\s+(?:senior\s+)?notes?|senior\s+(?:unsecured\s+)?notes?|debentures?/i`
- AND does NOT have "common stock" or "ordinary shares" in first 500 chars

**Why:** 424B5 is used for BOTH equity offerings and debt (convertible notes, senior notes). Debt offerings are irrelevant for the equity offerings watch. CELC $400M convertible notes had a spurious "offer price" of $91.42 extracted from conversion reference price text.

## Underwriter Extraction Patterns

For ATM offerings — agent named after "with":
- `(?:Sales|Offering) Agreement[^)]{0,60}\) with ([A-Z][A-Za-z\s.&]{3,55}?)(?:,|\(|LLC|Inc|Ltd|Co\.)`
- `at-the-market offering agreement[...] with ([A-Z]...)`

For Follow-on/IPO — standard patterns:
- `Sole Book-Running Manager ... [Name]`
- `Joint Book-Running Manager ... [Name]`  
- `Placement Agent ... [Name]`
- `([Name] LLC|Inc)[...](the Underwriter)` — Titan Partners Group style
- `payable to ([Name] LLC|Inc)` — referencing underwriting section

**cleanUw()** strips trailing `& ` (from "Name & Co." stopped at "&"), trailing LLC/Inc/Co, trailing punctuation.

## SEC EDGAR Access

- EFTS search: `https://efts.sec.gov/LATEST/search-index?forms=424B4,424B5&dateRange=custom&startdt=YYYY-MM-DD&enddt=YYYY-MM-DD`
- UA for EFTS: `wslexx/1.0 research@wslexx.com`
- Archives: `https://www.sec.gov/Archives/edgar/data/{cik_no_zeros}/{adsh_no_dashes}/{docname}`
- UA for Archives: `WS_LEXX-Research research@wslexx.com` (different UA format required)
- Response is gzip — Node.js `fetch()` decompresses automatically; in Python check `raw[:2] == b'\x1f\x8b'`
- Fetch first 150KB only (cover page contains all pricing info)
- Get docname from `https://data.sec.gov/submissions/CIK{10-digit-padded}.json` → `filings.recent.accessionNumber[]` + `filings.recent.primaryDocument[]`
- ticker extracted from `display_names` array: last element matching `\([A-Z]{1,5}\)$`
