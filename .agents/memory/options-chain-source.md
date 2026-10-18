---
name: Options chain data source
description: Which API to use for options chain data, and why Yahoo Finance fails from Replit
---

## Rule
Use NASDAQ's free options API, not Yahoo Finance, for options chain data.

## Why
- Yahoo Finance v7/finance/options requires crumb authentication since 2024.
- The crumb endpoint (query1.finance.yahoo.com/v1/test/csrfToken) returns HTTP 500 from Replit's server IP — it's blocked/unavailable from cloud environments.
- Yahoo Finance v8/finance/chart (used for stock quotes/candles elsewhere in the codebase) still works fine.
- NASDAQ's free API works without auth from Replit: `https://api.nasdaq.com/api/quote/{symbol}/option-chain?assetclass=stocks&limit=600&type=all`

## How to apply
- Endpoint returns delayed options data with bid/ask/volume/openInterest per strike.
- Use `assetclass=stocks` first; fall back to `etf`, then `index` for ETFs like SPY.
- IV (implied volatility) is NOT provided in NASDAQ free API — return `null` for iv field.
- NASDAQ only returns nearest 3-4 expirations (weekly). For monthly/LEAPS, a paid data source would be needed.
- Parse spot from the `data.lastTrade` string: `"LAST TRADE: $310.07 (AS OF...)"` — regex match `\$([0-9,]+\.?[0-9]*)`.
- Group rows by `expirygroup` field (header rows have truthy expirygroup, data rows have empty string).
- When filtering mapped expirations, use the actual field name — don't assume `.ts` if you named it `.timestamp`.

**Auth headers needed** (even though no token):
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...
Accept: application/json, text/plain, */*
Referer: https://www.nasdaq.com/
```
