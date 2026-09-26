# Portfolio Tracker

A static site (GitHub Pages) that tracks your portfolio month by month:

- **Portfolio tab**: net worth, gain vs. cost, what changed each month (new money vs. market movement), allocation, holdings, dividends/interest, and the full monthly history. Use **+ Add month** to enter a new month, like adding a row to *Investments & Savings*.
- **Monthly cash flow tab**: earnings, CPF deductions, expenses and investment allocation for each month, based on the *Money Transfer* sheet.

Your data lives in `data/portfolio.enc.json`, **encrypted with your passphrase** (AES-256-GCM). The repo can be public: without the passphrase, nobody can read the numbers.

## First-time setup

The site is at `https://<your-username>.github.io/investment-portfolio/`. To load your data the first time, do this on your Mac:

1. Create the GitHub token (see below).
2. Open the site → **GitHub sync settings** → paste the token → **Done**.
3. **Import a file** → pick `data/portfolio.json` (the plain export of `Debt.xlsx`).
4. Choose a passphrase (8+ characters). The site encrypts your data and commits `data/portfolio.enc.json` to the repo.

If you prefer the command line, run `node scripts/encrypt.mjs` and commit `data/portfolio.enc.json` yourself.

To re-import from Excel later, run `.venv/bin/python scripts/export_from_excel.py`, then use ⚙ Settings → Import file.

> A **private** repo also works with GitHub Pages on a paid plan (Pro/Team). The encryption protects your data either way.

## Saving from any device

Viewing only needs the passphrase. To **save** changes from a phone or laptop, give that browser a GitHub token:

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token.
2. Repository access: **Only select repositories** → `investment-portfolio`.
3. Permissions: **Contents → Read and write**. Nothing else.
4. On the site: ⚙ Settings → paste the token (owner/repo fill themselves on github.io).

Each save encrypts the data in the browser and commits it to `data/portfolio.enc.json`, so every change shows up in the repo's commit history. If two devices edit at the same time, the site notices and asks which version to keep.

The token is stored only in that browser's local storage. Revoke it on GitHub if you lose the device.

## Adding a month

**+ Add month** fills in last month's values, so you only change what moved:

- **Market value**: what the holding is worth at month end. You can type sums like `83536+76735.32`, just like in Excel.
- **Added this month**: new money you put in (negative for a withdrawal). The site keeps a running total, which becomes the cost basis used to calculate gain/loss. If you edit a past month's contribution, later months adjust automatically.
- **Dividends & interest** and a **note** for big one-off expenses.
- **TikTok RSU** is entered as **units × price**, and the site applies the 15% tax haircut (value = units × price × 0.85). After a buyback, just change the price.

To pick up a newer `data/portfolio.json` (e.g. one Claude updated), use ⚙ Settings → **Import file…** and choose **Cancel** at the prompt. That keeps your data and only adds what's new. **OK** replaces everything.

To edit a past month, tap its row in **Monthly history**. You can add, rename, reorder or hide holdings in ⚙ Settings → Assets. Untick **cost** for holdings with no purchase price, such as cash or RSUs.

## Files

| Path | What it is |
|---|---|
| `index.html`, `assets/` | The site: charts use Chart.js from jsDelivr; no build step |
| `assets/crypto.js` | Encryption, shared by the site and `encrypt.mjs` |
| `data/portfolio.enc.json` | Your encrypted data (commit this) |
| `data/portfolio.json` | Plain export: **git-ignored, never commit** |
| `scripts/export_from_excel.py` | `Debt.xlsx` → `data/portfolio.json` |
| `scripts/encrypt.mjs` | Encrypt (or `--decrypt`) the data file |

## IBKR funds

The sheet tracked the whole IBKR account as one "IWDA" number. `scripts/split_ibkr.py` splits it into funds (IWDA, QQQM, SLV, GLD, GLDM, NLR, ITPS, XYLD, ELFY) plus IBKR cash, using data pulled from IBKR into the git-ignored `data/ibkr/` folder:

- **Jun 2025 onward:** each fund's month-end quantity is rebuilt by rewinding IBKR trades from current positions, then valued at IBKR month-end prices. The totals match IBKR's own ETF totals to within 0.1%.
- **Before Jun 2025:** one "IBKR (all funds)" line. IBKR's trade history doesn't go back further.
- **Cost:** IBKR's "invested" is your sheet's contribution total (S$128K by Aug 2026). IWDA was transferred in from Standard Chartered, so IBKR records its cost as the value on the transfer date, not what you paid. Funds bought inside IBKR get their real SGD cost (trade amount × USD/SGD that month), and IWDA gets the rest of the total. IWDA's gain therefore also includes the gains from IWDA shares sold in 2025 to buy SLV, GLD and QQQM.

Funds sharing an **account** (⚙ Settings → Assets) show as one band in the trend chart and are grouped in the holdings table.

```sh
.venv/bin/python scripts/export_from_excel.py && .venv/bin/python scripts/split_ibkr.py
```

## Notes on the imported history

- Sep–Oct 2022 and Mar 2024 were mostly blank in the sheet. Those values are interpolated and marked `~`.
- REIT cost basis = Nikko + Phillip purchases. Phillip's cost is removed from Nov 2024, after it was sold.
- "Money put in" counts cost basis for cost-tracked holdings plus the face value of cash and RSUs. So RSU price moves show up as new money, not market gain.

To run it locally: `python3 -m http.server 8000`, then open http://localhost:8000.
