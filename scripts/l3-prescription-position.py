#!/usr/bin/env python3
"""L3 measurement — where does a memory's actionable prescription sit relative to
the per-row truncation applied before startup/prompt injection?

Background: token-budget.ts truncates each injected row to DEFAULT_PER_ROW_CHAR_CAP
chars. If the "what to do next" part of a memory sits past that cut, the memory is
delivered as a symptom report with no prescription — surfaced, but not actionable.

Usage:
    python3 scripts/l3-prescription-position.py [--days 30 | --since YYYY-MM-DD] [--cap 149]

DB path: $CCRECALL_DB_PATH, else ~/.ccrecall/ccrecall.db. So the no-arg default
IS the production database — what this avoids is the Tier 0 acceptance script's
`:27` defect of making that the ONLY reachable path. The resolved path is printed
on every run, so measuring production is visible rather than silent.

Exit codes are about trustworthiness, not completion: 0 only when the numbers can
be used as evidence, 1 when the script printed a reason they cannot be (empty
window, no locatable samples, counter-probe failed, locator possibly destroyed),
2 on bad arguments or a missing DB.
"""
import argparse
import os
import pathlib
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
# Punctuation classes matter more than they look on a Traditional-Chinese corpus:
# a marker introduced by a fullwidth colon, or preceded by 、，；！？ rather than a
# period, used to fall outside the pattern entirely. Every such miss landed in the
# "no locatable prescription" bucket, which is also what a *successful* rewrite
# looks like — so the blind spot bent the number in the direction of the change
# being measured. Leading bullets are allowed for the same reason.
_SEP = r"[.,;:!?。，、；！？]"
RX = re.compile(
    r"(?:^\s*(?:[-*]\s*)?|" + _SEP + r"\s*)(" + PRESCRIPTION_MARKERS + r")\s*[:：]",
    re.M | re.I,
)


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

    # Both window flags fail silently when malformed, in opposite directions, and
    # the acceptance gate is literally `--since 2026-09-09`: `--since 09-09-2026`
    # is a lexical TEXT compare that matches every row and still exits 0, while
    # `--days -30` builds a modifier SQLite evaluates to NULL and reports an empty
    # window with advice ("widen --days") that is exactly backwards.
    if args.since and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.since):
        print(f"--since must be YYYY-MM-DD, got {args.since!r} — SQLite compares "
              f"created_at lexically, so a malformed value silently measures the "
              f"whole database", file=sys.stderr)
        return 2
    if args.days <= 0:
        print(f"--days must be positive, got {args.days} — a negative modifier "
              f"makes date() return NULL and every row falls outside the window",
              file=sys.stderr)
        return 2

    db = resolve_db()
    if not os.path.exists(db):
        print(f"DB not found: {db}", file=sys.stderr)
        return 2
    print(f"DB : {db}")
    # as_uri() percent-escapes the path. Interpolating it raw let a `?` or `#` in
    # the path truncate the URI, discarding `mode=ro` — which opens read-write and
    # CREATES the file, in an application whose first rule is that it never writes.
    con = sqlite3.connect(pathlib.Path(db).resolve().as_uri() + "?mode=ro", uri=True)
    # The population has to match what the injection path can actually select, or
    # the headline describes memories no session will ever be shown:
    #   - type/confidence mirror getStartupMemories' Tier 0 filters
    #     (src/core/database.ts:2057-2058).
    #   - compression_level = 0 is the load-bearing one. Rotation permanently
    #     rewrites content, stripping the markers: measured 2026-09-08 over 30
    #     days, cl=0 rows carry a marker 26.8% of the time (median length 687)
    #     against 0.3% for compressed ones (median 153). Including them measures
    #     the compressor's output as if the extraction prompt had written it, and
    #     drags the locatable share toward this script's own <10% tripwire — a
    #     share that then falls purely as the corpus ages, firing the "metric may
    #     be destroyed" warning for a reason unrelated to any prompt change.
    where = "compression_level = 0 AND type != 'query' AND confidence >= 0.8"
    cols = "SELECT id, date(created_at), COALESCE(key,''), content FROM memories WHERE "
    if args.since:
        print(f"窗口: {args.since} 起   |   截斷線: {args.cap} 字元")
        rows = con.execute(cols + where + " AND date(created_at) >= ?", (args.since,)).fetchall()
    else:
        print(f"窗口: 近 {args.days} 天   |   截斷線: {args.cap} 字元")
        rows = con.execute(
            cols + where + " AND date(created_at) >= date('now', ?)", (f"-{args.days} days",)
        ).fetchall()
    con.close()
    print("母體限定: 未壓縮(compression_level=0) + Tier 0 可選(type/confidence) — "
          "壓縮過的 content 是壓縮器寫的, 不是 extraction prompt 寫的")
    print()

    if not rows:
        print("PIPELINE EMPTY: 0 rows in window — widen --days or check the DB, "
              "do not read this as '0% of prescriptions are cut'", file=sys.stderr)
        return 1

    # Print the realised range, not just the requested one: it is the only thing
    # that shows a window flag did something other than what its label says.
    dates = sorted(r[1] for r in rows if r[1])
    span = f"{dates[0]} .. {dates[-1]}" if dates else "無日期"
    print(f"母體: {len(rows)} 筆   |   實際日期範圍 {span}   |   "
          f"平均全長 {statistics.mean(len(r[3]) for r in rows):.0f} 字元")
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

    # m.start() is the offset of the consumed separator, not of the marker; only
    # group 1 is the marker itself. The delta ran 2-3 chars over the live corpus,
    # always UNDER-reporting cuts — harmless at a median offset of 451, but this
    # is the acceptance instrument for a change whose whole purpose is to move
    # prescriptions to just inside the cap, i.e. into exactly the band where a
    # 2-char bias flips the verdict, and it flips it toward "delivered".
    cut = [(r, m) for r, m in has if m.start(1) >= args.cap]
    keep = [(r, m) for r, m in has if m.start(1) < args.cap]
    print(f">>> 處方落在截斷線【之後】(送不到): {len(cut):4d}/{len(has)} = {100*len(cut)/len(has):.1f}%")
    print(f"    處方落在截斷線【之內】(送得到): {len(keep):4d}/{len(has)} = {100*len(keep)/len(has):.1f}%")
    # A marker that merely starts inside the cap can still have its own text cut
    # in half, so the stricter count is the honest lower bound on "readable".
    whole = sum(1 for _, m in has if m.end(1) <= args.cap)
    print(f"    (其中標記完整落在線內的: {whole} 筆 — 起點在線內不代表處方讀得完)")
    print()

    pos = sorted(m.start(1) for _, m in has)
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
        r, m = min(keep, key=lambda x: x[1].start(1))
        print(f"  最早處方位置 {m.start(1)} 字元: {r[2] or r[0]}")
    print()

    print("--- 落在截斷線後最遠的 8 筆 ---")
    for r, m in sorted(cut, key=lambda x: -x[1].start(1))[:8]:
        print(f"  @{m.start(1):4d} (全長{len(r[3]):4d})  {r[2] or r[0]}")

    # The measurement can be destroyed by the very fix it is measuring: once the
    # extraction prompt asks for the action in the first sentence, memories stop
    # needing a "Mitigation:"-style label, and this marker-based locator finds
    # fewer of them. A falling "有明確處方段" is therefore ambiguous.
    # Exit code tracks trustworthiness, not "did python finish". Every state that
    # prints "do not trust this output" used to return 0, so `script && publish`
    # published precisely the runs the script had disowned.
    untrusted = []
    if not keep:
        untrusted.append("counter-probe 失敗(無線內樣本, 指標恆為 FAIL)")
    if len(has) / len(rows) < 0.10:
        print()
        print("⚠️  可定位比例 <10% — 這個指標可能已被它量測的改動破壞。")
        print("    處方標記詞消失有兩種解釋:(a) 處方寫進首句不再需要標籤(想要的結果)")
        print("    (b) 處方根本沒寫(不想要的結果)。**兩者在本指標下長得一樣**。")
        print("    要分辨只能人工抽樣讀前 %d 字元, 不要用本數字下結論。" % args.cap)
        untrusted.append("可定位比例 <10%")
    print()
    if untrusted:
        print(f"[exit 1] 本次輸出不可作為判定依據: {' / '.join(untrusted)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
