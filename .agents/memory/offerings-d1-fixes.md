---
name: Offerings Watch D-1 search and price accuracy fixes
description: Key bugs and fixes for EDGAR 424B/offerings parsing: dedup, price reference vs actual, UW with periods
---

## D-1 → D search window
Companies price at close of Day T and file 424B5 the morning of T+1. Search `startdt=prevBusinessDay(day)&enddt=day` to catch both. Single-day search misses all overnight filings.

**Why:** GOOGL ATM $40B and CEG $3.09B were both filed Jun 2 for a Jun 3 presentation.

## Deduplication: keep FIRST hit per ticker (not latest)
EFTS returns hits in adsh-descending order within the same date. The first hit = highest adsh = most recent/final filing. Change `fileDate >= existing.fileDate` → `fileDate > existing.fileDate` so same-date filings keep the first occurrence (final, non-preliminary).

**Why:** GOOGL had 4 filings on Jun 2; the last processed was a preliminary → isPreliminary=true → correctly filtered but incorrectly because the final filing was replaced.

## isPreliminary filter
424B5 files "preliminary prospectus supplement / not complete and may be changed" BEFORE pricing is set. Check both phrases in coverPage and skip these candidates.

**Why:** TTI filed preliminary 424B5 before pricing; the 8-K pricing announcement comes first, then final 424B5 next day.

## Price pattern priority: table before reference
Prospectuses print the last-sale reference price ("last reported sale price was $95.29") BEFORE the pricing table ("Public offering price $ 85.00 $ 225,000,015"). Always match "Public Offering Price $ X" BEFORE the generic "$ X.XX per share" pattern, or you get the reference price.

**How to apply:** pricePats order: Public Offering Price → Price to Public → Price Per Share → generic per-share.

## Deal size: pricing table total column
"Public offering price $ 85.00 $ 225,000,015" — the second dollar column is the aggregate. Pattern: `/[Pp]ublic\s+[Oo]ffering\s+[Pp]rice\s+\$\s*[\d,.]+\s*\$\s*([\d,]+)/i`. Put this FIRST in dealPats before "Up to $" ATM pattern.

## Seller type: Shareholders vs Stockholders
Pattern must include both: `/[Ss]elling\s+(?:[Ss]tockholders?|[Ss]hareholders?)/`. CEG used "Selling Shareholders" not "Stockholders".

## Underwriter: J.P. Morgan periods
`[A-Za-z\s&]` char class won't match "J.P. Morgan". Use named-bank alternation strings with escaped dots: `J\\.P\\.\\s+Morgan|Goldman\\s+Sachs|Morgan\\s+Stanley|...` constructed via `new RegExp(BANKS)`.

## Cover-page naked UW listing (highest priority)
424B4s often just list bank names on cover: "Morgan Stanley J.P. Morgan The date of this prospectus supplement...". Pattern: `\b(BANKS)\b[\s\S]{0,150}?The\s+date\s+of\s+this\s+prospectus` with `[\s\S]` to handle periods in J.P. Morgan. Use as priority-1 check BEFORE uwPats loop. "payable to [Name] LLC" pattern must be LOWEST priority — it catches any bank mentioned as payee (not necessarily lead).

## MLYS / same-day 8-K pricing
Some companies price via 8-K press release without immediately filing 424B5. The 424B5 appears D+1. No reliable programmatic way to parse 8-K pricing from EDGAR EFTS without high false-positive rate (MDLN/ESAB/FLY 8-K hits are debt/agreements/not equity). Accept that these appear the next day.
