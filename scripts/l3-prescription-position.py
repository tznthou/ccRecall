#!/usr/bin/env python3
"""L3 measurement — where does a memory's actionable prescription sit relative to
the per-row truncation applied before startup/prompt injection?

Background: token-budget.ts truncates each injected row to DEFAULT_PER_ROW_CHAR_CAP
chars. If the "what to do next" part of a memory sits past that cut, the memory is
delivered as a symptom report with no prescription — surfaced, but not actionable.

Usage:
    python3 scripts/l3-prescription-position.py [--days 30] [--cap 149]

DB path resolution (never hardcoded — the Tier 0 acceptance script's `:27` defect
was exactly this): $CCRECALL_DB_PATH, else ~/.ccrecall/ccrecall.db. The resolved
path is printed so a run against the production DB is visible, not silent.
"""
import argparse
import os
import re
import sqlite3
import statistics
import sys

# token-budget.ts:9 DEFAULT_PER_ROW_CHAR_CAP = 150; truncateToChars keeps
# maxChars - 1 chars and appends an ellipsis, so 149 is what actually survives.
DEFAULT_CAP = 149

# Markers harvested from the corpus itself via a frequency scan, not written from
# memory. Re-run that scan before trusting this list on a materially different corpus.
PRESCRIPTION_MARKERS = (
    "Mitigation|Solution|Fix|Prevention|Correct approach|Workaround|Remedy|"
    "Detection method|Correction|Lesson|How to apply|Rule|解法|修法|判準"
)
RX = re.compile(r"(?:^|[.\n。;]\s*)(" + PRESCRIPTION_MARKERS + r")\s*[::]", re.M)


def resolve_db() -> str:
    return os.environ.get("CCRECALL_DB_PATH") or os.path.expanduser("~/.ccrecall/ccrecall.db")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="lookback window (default 30)")
    ap.add_argument("--since", help="absolute start date YYYY-MM-DD; overrides --days. "
                                    "Use this to measure only memories written after a "
                                    "prompt change, so pre- and post- samples never mix.")
    ap.add_argument("--cap", type=int, default=DEFAULT_CAP,
                    help=f"per-row char cap surviving truncation (default {DEFAULT_CAP})")
    args = ap.parse_args()

    db = resolve_db()
    if not os.path.exists(db):
        print(f"DB not found: {db}", file=sys.stderr)
        return 2
    print(f"DB : {db}")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    if args.since:
        print(f"窗口: {args.since} 起   |   截斷線: {args.cap} 字元")
        rows = con.execute(
            "SELECT id, date(created_at), COALESCE(key,''), content FROM memories "
            "WHERE date(created_at) >= ?", (args.since,)
        ).fetchall()
    else:
        print(f"窗口: 近 {args.days} 天   |   截斷線: {args.cap} 字元")
        rows = con.execute(
            "SELECT id, date(created_at), COALESCE(key,''), content FROM memories "
            "WHERE date(created_at) >= date('now', ?)", (f"-{args.days} days",)
        ).fetchall()
    con.close()
    print()

    if not rows:
        print("PIPELINE EMPTY: 0 rows in window — widen --days or check the DB, "
              "do not read this as '0% of prescriptions are cut'", file=sys.stderr)
        return 1

    print(f"母體: {len(rows)} 筆   |   平均全長 {statistics.mean(len(r[3]) for r in rows):.0f} 字元")
    print()

    has = [(r, RX.search(r[3])) for r in rows]
    has = [(r, m) for r, m in has if m]
    n_non = len(rows) - len(has)
    print(f"有明確處方段: {len(has):4d}/{len(rows)} = {100*len(has)/len(rows):.1f}%")
    print(f"無明確標記  : {n_non:4d}/{len(rows)} = {100*n_non/len(rows):.1f}%   "
          f"(處方可能混在敘述裡, 本法測不到 — 見限制)")
    print()

    if not has:
        print("無可定位樣本 — 指標本次沒有判定力, 不要輸出百分比", file=sys.stderr)
        return 1

    cut = [(r, m) for r, m in has if m.start() >= args.cap]
    keep = [(r, m) for r, m in has if m.start() < args.cap]
    print(f">>> 處方落在截斷線【之後】(送不到): {len(cut):4d}/{len(has)} = {100*len(cut)/len(has):.1f}%")
    print(f"    處方落在截斷線【之內】(送得到): {len(keep):4d}/{len(has)} = {100*len(keep)/len(has):.1f}%")
    print()

    pos = sorted(m.start() for _, m in has)
    print(f"處方起始位置: 中位 {statistics.median(pos):.0f} / 平均 {statistics.mean(pos):.0f} "
          f"/ 最小 {pos[0]} / 最大 {pos[-1]}")
    print(f"中位處方位置 = 截斷線的 {statistics.median(pos)/args.cap:.1f}x")
    lens = [len(r[3]) for r, _ in has]
    print(f"有處方者中位全長 {statistics.median(lens):.0f} 字元 "
          f"=> 注入只送出前 {100*args.cap/statistics.median(lens):.0f}%")
    print()

    # Counter-probe: a metric that cannot say "fine" for anything is not measuring.
    verdict = "YES, 指標有辨別力" if keep else "NO — 指標恆為 FAIL, 結果不可信"
    print(f"[counter-probe] 存在處方在線內的樣本嗎? {len(keep)} 筆 -> {verdict}")
    if keep:
        r, m = min(keep, key=lambda x: x[1].start())
        print(f"  最早處方位置 {m.start()} 字元: {r[2] or r[0]}")
    print()

    print("--- 落在截斷線後最遠的 8 筆 ---")
    for r, m in sorted(cut, key=lambda x: -x[1].start())[:8]:
        print(f"  @{m.start():4d} (全長{len(r[3]):4d})  {r[2] or r[0]}")

    # The measurement can be destroyed by the very fix it is measuring: once the
    # extraction prompt asks for the action in the first sentence, memories stop
    # needing a "Mitigation:"-style label, and this marker-based locator finds
    # fewer of them. A falling "有明確處方段" is therefore ambiguous.
    if len(has) / len(rows) < 0.10:
        print()
        print("⚠️  可定位比例 <10% — 這個指標可能已被它量測的改動破壞。")
        print("    處方標記詞消失有兩種解釋:(a) 處方寫進首句不再需要標籤(想要的結果)")
        print("    (b) 處方根本沒寫(不想要的結果)。**兩者在本指標下長得一樣**。")
        print("    要分辨只能人工抽樣讀前 149 字元, 不要用本數字下結論。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
