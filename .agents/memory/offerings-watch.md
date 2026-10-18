---
name: Offerings Watch page
description: Architecture of the Offerings Watch feature — data sources, enrichment pipeline, rating algorithm
---

## Route
- API: `GET /api/offerings/watch?day=YYYY-MM-DD`
- Frontend: `/offerings` page in edge-tracker
- Route file: `artifacts/api-server/src/routes/offerings.ts`
- Frontend file: `artifacts/edge-tracker/src/pages/offerings.tsx`

## Data Pipeline

1. **NASDAQ IPO Calendar** → upcoming IPOs for the month (offers prices, deal sizes)  
2. **SEC EDGAR EFTS** → 424B4/424B5 filings for the specific day → Follow-on / ATM classification  
3. **SEC Archives** → parse each filing's HTML for: offer price, shares offered, deal size, underwriter, seller type, lockup, shares outstanding, ATM/debt flags  
4. **Yahoo Finance** → current price, price change %, volume, market cap, shares outstanding for dilution calculation  
5. **Merge** NASDAQ IPOs + EDGAR offerings, de-duplicate by ticker  
6. **Rating algorithm** (0–100) based on: deal size, type (IPO > Follow-on > ATM), status (trading > upcoming), dilution, price change, market cap  

## Cache
- Key: `offerings_day_{YYYY-MM-DD}`, TTL: 10 minutes (NodeJS Map in-process)

## BOND_ISSUERS filter
Set of major financial institution tickers (JPM, GS, MS, BAC, C, WFC...) that routinely file 424B5 for bond issuances — filtered out of equity offerings.

## Frontend
- Day navigation: ← Вчера / Today / Завтра →
- Filter bars: by type (IPO/Follow-on/ATM/SPAC), status (trading/upcoming), seller
- Sortable table with expanded detail rows
- Summary stats bar (deal totals by type, avg price change)

## Known Limitations
- IPO underwriters not available from NASDAQ source (only from EDGAR filings, which IPOs don't have on pricing day)
- ATM dilution not computed (variable shares by definition)
