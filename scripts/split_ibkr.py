"""Split the lumped IBKR line in data/portfolio.json into individual funds.

The sheet tracked the whole IBKR account as one number ("IWDA"). This rebuilds
each fund's month-end quantity by rewinding IBKR trades from today's positions,
values it with IBKR month-end prices, and scales to IBKR's own ETF total.

Cost follows the sheet: the IBKR account's "invested" stays exactly the sheet's
contribution total, split across funds in proportion to IBKR's cost basis. So
per-fund gains are comparable with each other, but scaled to your contributions
rather than IBKR's (which also counts gains you rolled over when switching funds).

Months before the trade history starts stay as one "IBKR (all funds)" line.

Inputs (git-ignored, pulled from IBKR): data/ibkr/{positions.json, trades.csv, market.json}

    .venv/bin/python scripts/export_from_excel.py && .venv/bin/python scripts/split_ibkr.py
"""

import csv
import json
from calendar import monthrange
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IB = ROOT / "data" / "ibkr"
PF = ROOT / "data" / "portfolio.json"

FUNDS = {  # symbol -> (asset id, display name)
    "IWDA": ("iwda", "IWDA · MSCI World"),
    "QQQM": ("qqqm", "QQQM · Nasdaq 100"),
    "SLV": ("slv", "SLV · Silver"),
    "GLD": ("gld", "GLD · Gold"),
    "GLDM": ("gldm", "GLDM · Gold mini"),
    "NLR": ("nlr", "NLR · Uranium & nuclear"),
    "ITPS": ("itps", "ITPS · US TIPS"),
    "XYLD": ("xyld", "XYLD · Covered call"),
    "ELFY": ("elfy", "ELFY · Electrification"),
}
GROUP = "IBKR"


def month_end(m):
    y, mo = map(int, m.split("-"))
    return f"{m}-{monthrange(y, mo)[1]:02d}"


def main():
    pos = json.loads((IB / "positions.json").read_text())
    mk = json.loads((IB / "market.json").read_text())
    trades = list(csv.DictReader((IB / "trades.csv").open()))
    data = json.loads(PF.read_text())

    if any(a["id"] == "ibkr" for a in data["assets"]):
        raise SystemExit("portfolio.json is already split — re-run export_from_excel.py first.")

    idx = {m: i for i, m in enumerate(mk["months"])}
    now = {p["symbol"]: p for p in pos["positions"]}

    def usdsgd(m):
        return mk["close"]["USDSGD"][idx[m]]

    def to_sgd(m, sym, amount):
        rate = usdsgd(m) if now[sym]["currency"] == "USD" else mk["GBPSGD"].get(m, 1.72)
        return amount * rate

    def qty_at(m):
        end = month_end(m)
        q = {s: now[s]["qty"] for s in now}
        for t in trades:
            if t["date"] > end:
                q[t["symbol"]] += -float(t["size"]) if t["side"] == "BUY" else float(t["size"])
        return q

    split_months = sorted(mk["alloc_usd"])  # month-ends IBKR gave us totals for
    first = split_months[0]

    # --- Assets: IBKR combined (history) + one per fund + IBKR cash, all in the IBKR group
    old = {a["id"]: a for a in data["assets"]}
    ibkr_assets = [{"id": "ibkr", "name": "IBKR (all funds)", "costTracked": True, "group": GROUP, "archived": True}]
    ibkr_assets += [{"id": aid, "name": name, "costTracked": True, "group": GROUP} for aid, name in FUNDS.values()]
    ibkr_assets += [{"id": "ibkr_cash", "name": "IBKR cash", "costTracked": False, "group": GROUP}]
    others = [a for aid, a in old.items() if aid != "iwda"]
    data["assets"] = ibkr_assets + others

    months = {m["month"]: m for m in data["months"]}
    for m in sorted(months):
        rec = months[m]
        lump_v = rec["values"].pop("iwda", None)
        lump_c = rec["invested"].pop("iwda", None)
        est = rec.get("estimated", [])
        if "iwda" in est:
            est[est.index("iwda")] = "ibkr"

        if m < first or m not in mk["alloc_usd"]:
            if lump_v is not None:
                rec["values"]["ibkr"] = lump_v
            if lump_c is not None:
                rec["invested"]["ibkr"] = lump_c
            continue

        # Values: rewound quantities x month-end close, scaled to IBKR's ETF total for that date.
        q = qty_at(m)
        raw = {s: to_sgd(m, s, q[s] * mk["close"][s][idx[m]]) for s in now if q[s] > 1e-6}
        target = mk["alloc_usd"][m]["etf"] * usdsgd(m)
        scale = target / sum(raw.values())
        cash = mk["alloc_usd"][m]["cash"] * usdsgd(m)
        for s, v in raw.items():
            rec["values"][FUNDS[s][0]] = round(v * scale, 2)
        rec["values"]["ibkr_cash"] = round(cash, 2)

        # Cost: the sheet's IBKR contributions (lump_c) minus cash, split across funds
        # in proportion to IBKR's own cost basis for each fund at that month-end.
        pool = (lump_c or 0) - cash
        end = month_end(m)
        cost = {s: now[s]["qty"] * now[s]["avg"] for s in now}
        for t in trades:
            if t["date"] <= end:
                continue
            net, com, pnl = (float(t[k]) for k in ("net", "commission", "realized_pnl"))
            cost[t["symbol"]] += -(net + com) if t["side"] == "BUY" else net - com - pnl
        w = {s: to_sgd(m, s, cost[s]) for s in raw}
        inv = {s: pool * w[s] / sum(w.values()) for s in raw}
        for s, v in inv.items():
            if s in raw:
                rec["invested"][FUNDS[s][0]] = round(v, 2)


    data["months"] = [months[m] for m in sorted(months)]
    PF.write_text(json.dumps(data, indent=1, ensure_ascii=False))

    # Report
    for m in split_months:
        rec = months.get(m)
        if not rec:
            continue
        ib = [a["id"] for a in ibkr_assets]
        v = sum(rec["values"].get(a, 0) for a in ib)
        c = sum(rec["invested"].get(a, 0) for a in ib) + rec["values"].get("ibkr_cash", 0)
        print(f"{m}  IBKR value S${v:>10,.0f}   put in S${c:>10,.0f}")
    last = months[split_months[-1]]
    print("\nLatest split:")
    for aid, name in [(a["id"], a["name"]) for a in ibkr_assets]:
        if aid in last["values"]:
            inv = last["invested"].get(aid)
            v = last["values"][aid]
            g = f"{100 * (v / inv - 1):+.0f}%" if inv else ""
            print(f"  {name:26} S${v:>10,.0f}   cost S${inv or 0:>10,.0f}  {g}")


if __name__ == "__main__":
    main()
