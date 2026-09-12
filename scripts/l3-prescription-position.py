#!/usr/bin/env python3
"""L3 measurement — can a reader act on the part of a memory that survives the
per-row truncation applied before startup/prompt injection?

Background: token-budget.ts truncates each injected row to DEFAULT_PER_ROW_CHAR_CAP
chars. If the "what to do next" part of a memory sits past that cut, the memory is
delivered as a symptom report with no prescription — surfaced, but not actionable.

Usage:
    python3 scripts/l3-prescription-position.py [--days 30 | --since YYYY-MM-DD] [--cap 149]
    python3 scripts/l3-prescription-position.py --test               # locator unit tests, no DB
    python3 scripts/l3-prescription-position.py --self-check [PATH]  # score locator vs human labels

DB path: $CCRECALL_DB_PATH, else ~/.ccrecall/ccrecall.db. So the no-arg default
IS the production database — what this avoids is the Tier 0 acceptance script's
`:27` defect of making that the ONLY reachable path. The resolved path is printed
on every run, so measuring production is visible rather than silent.

Exit codes are about trustworthiness, not completion: 0 only when the numbers can
be used as evidence, 1 when the script printed a reason they cannot be (empty
window, no locatable samples, counter-probe failed, locator possibly destroyed),
2 on bad arguments or a missing DB.

────────────────────────────────────────────────────────────────────────────────
2026-09-12 — WHY THERE ARE NOW TWO LOCATORS

The marker locator below (Mitigation:/Solution:/解法: …) was the original
instrument. It measured the extraction prompt change of PR #107 as **worse than
no change**: over the whole post-change window it puts a prescription inside the
cap for 0 of 17 locatable rows (0.0%), against 1 of 54 (1.9%) for the pre-change
window. Read alone, it says #107 made things worse.

Two blind human reads of 79 rows from those same two windows — labels fixed
before any row was read, arms mixed and hidden, two independent draws — found
28/40 post-change against 13/39 pre-change (Fisher exact p = 0.0016).

The marker locator was not merely imprecise, it was answering a different
question. #107 asked the model to lead with the prescription — and a memory whose
first sentence IS the prescription has no reason to carry a "Mitigation:" label.
23 of the 28 post-change hits carried no marker anywhere in the row. The
instrument's signal fell exactly because the change worked.

Hence: the actionability probe is the primary metric, the marker locator is kept
as a legacy cross-check, and the two are always printed side by side. When they
disagree in the way described above, that disagreement is itself the finding.
The probe approximates a human judgement with regular expressions and WILL be
wrong on individual rows; --self-check exists so that its error rate against
human labels is a number this script prints rather than a thing you assume.
"""
import argparse
import json
import os
import pathlib
import re
import sqlite3
import statistics
import sys

# token-budget.ts:20 DEFAULT_PER_ROW_CHAR_CAP = 150; truncateToChars keeps
# maxChars - 1 chars and appends an ellipsis, so 149 is what actually survives.
DEFAULT_CAP = 149

# Default location of the human-labelled set used by --self-check. Under the
# repo's git-ignored .claude/, resolved from __file__ so it does not depend on the
# caller's cwd. Deliberately not in the repo proper: the labels are keyed by
# memory id, and resolving them needs the local production DB, whose contents
# carry private project names and paths. Deliberately not under ~/.claude/ either
# — this project's first rule is that it never writes there, and a file it reads
# by default from that tree invites the next reader to assume the rule has holes.
DEFAULT_ANNOTATIONS = str(pathlib.Path(__file__).resolve().parent.parent / ".claude" / "l3-annotation-set.json")

# ── Legacy locator: explicit prescription labels ────────────────────────────────
# Markers harvested from the corpus itself via a frequency scan, not written from
# memory. Re-run that scan before trusting this list on a materially different corpus.
#
# 2026-09-12 scan of the 279 uncompressed memories since 09-01 found the CJK half
# of this list is effectively dead code — 必須 0 hits, 別 0, 一律 1, 要 2 — because
# extraction writes English. Kept anyway: it costs nothing and a locale change
# would revive it. Do not read a CJK hit count of ~0 as "CJK memories have no
# prescriptions"; it means there are almost no CJK memories.
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
RX_MARKER = re.compile(
    r"(?:^\s*(?:[-*]\s*)?|" + _SEP + r"\s*)(" + PRESCRIPTION_MARKERS + r")\s*[:：]",
    re.M | re.I,
)

# ── Primary locator: actionability probe ────────────────────────────────────────
# Verb list is evidence-based, not imagined: every entry either appeared >= 4 times
# as the first word after a comma/dash in the 2026-09-01.. corpus (verify 17,
# check 13, grep 10, run 6, ask 4, use 4, count 4, test 8) or was the operative
# verb of a row a human labelled "actionable" in the 2026-09-12 blind read
# (measure, compress, place, establish, override, keep, complete, record, treat).
#
# To re-harvest on a different corpus:
#   split content on sentence enders and on /[,，—–-]\s+/, count the leading
#   [a-z]{3,} token of each fragment, then keep the bare-infinitive verbs.
# Adding verbs from intuition rather than from that scan is how this becomes a
# list that matches everything and discriminates nothing.
ACTION_VERBS = (
    "verify|check|grep|run|ask|use|count|test|measure|compress|place|establish|"
    "override|keep|complete|record|treat"
)
# An imperative sits at the start of a sentence, or after the comma that closes a
# leading "When …"/"Before …" clause — which the corpus scan showed is where this
# codebase's prescriptions actually live ("When adding code next to a test-guarded
# path, verify the test's scope …").
#
# The trailing guard is `(?![\w-])`, not `\b`: this corpus is full of tool names
# built from these very verbs, and a comma-separated list of them looks exactly
# like a comma-separated list of instructions: "the three scripts
# (check-links.sh, verify-schema.py) scan the tree" scored as actionable under
# `\b`, because `check` sat after ", " and ended at a hyphen, which `\b` accepts.
# A verb followed by `-` or `.` is a filename or a flag, not an instruction.
_IMPERATIVE_HEAD = r"(?:^|(?<=[.!?。！？])\s|(?<=[,，:：—–])\s|(?<=\n))"
RX_IMPERATIVE = re.compile(
    _IMPERATIVE_HEAD + r"(?:always\s+|first[,]?\s+)?(" + ACTION_VERBS + r")(?![\w.-])",
    re.M | re.I)
# Obligation and prohibition. `never|cannot` are deliberately NOT here: in this
# corpus they describe behaviour ("CodeRabbit never produces findings", "the
# scripts scan project memory only, never global files") about as often as they
# forbid it, and both readings look identical to a regex. They are scored as WEAK.
RX_OBLIGATION = re.compile(r"\b(must|should|do not|don't|never\s+(?:" + ACTION_VERBS + r"))\b", re.I)
# WEAK signals: real prescriptions hide here, but so do plain statements of fact.
# Counting them separately is what turns one misleading number into an interval.
RX_WEAK = re.compile(r"\b(never|cannot|can't|instead of|rather than|not just|not only)\b", re.I)

# Quoted spans are masked before the STRONG pass. A quoted imperative is usually an
# example being discussed, not an instruction being given: a row reading
# `the rule "check the cache first" stopped working when …` is a symptom report,
# and human labelling treated it as one.
#
# The single-quote arm needs the word-boundary guards. Without them `'[^']{2,}'`
# treats the apostrophes in ordinary English as quote delimiters: in "…the
# entity's ID is runtime-generated (unsuitable for static manifest), don't change
# the lookup direction" it masks everything from `'s` to `don'`, swallowing the
# prohibition this probe exists to find. That row was a false negative against
# the human labels until the guards went in.
RX_QUOTED = re.compile(r"`[^`]*`|\"[^\"]*\"|「[^」]*」|(?<!\w)'[^']{2,}'(?!\w)")


def mask_quotes(text: str) -> str:
    """Replace quoted spans with spaces, preserving offsets so positions stay true."""
    return RX_QUOTED.sub(lambda m: " " * len(m.group(0)), text)


def probe(text: str):
    """Locate the first actionable instruction.

    Returns (strong_start, strong_end, weak_start): character offsets of the first
    STRONG signal (start and end of the matched verb/modal) and the first WEAK one,
    or None. STRONG ignores quoted spans; WEAK does not.

    Callers compare strong_END against the cap, not strong_start. A verb whose
    first letters land inside the cap and whose remainder does not is not
    delivered: the live corpus contains a row whose instruction begins at 145 and
    reaches the reader as the five letters before the cut. Scoring that as
    delivered is the same off-by-a-few optimism the legacy locator was warned
    about.
    """
    masked = mask_quotes(text)
    hits = [(m.start(1), m.end(1))
            for m in (RX_IMPERATIVE.search(masked), RX_OBLIGATION.search(masked)) if m]
    strong = min(hits) if hits else (None, None)
    w = RX_WEAK.search(text)
    return strong[0], strong[1], (w.start(1) if w else None)


# ── Self-test: synthetic strings only, never production rows ───────────────────
# Each case is a failure this probe was seen to make, or a distinction it has to
# hold. Synthetic on purpose — a fixture cut from real memories would put private
# project names and paths in a public repo.
TEST_CASES = [
    # (text, expect_strong_within_cap, why)
    ("When adding code next to a test-guarded path, verify the test's scope covers it.",
     True, "imperative after a leading When-clause — the corpus's dominant shape"),
    ("Measure RESUME.md health in bytes, never line count.",
     True, "sentence-initial imperative"),
    ("Canary strings must be literal excerpts copied from the file.",
     True, "obligation modal"),
    ("When a mutation survives, do not assume the mutation broke the behaviour.",
     True, "prohibition"),
    ("Harness effect on model output is an independent variable across CLI providers.",
     False, "a finding with no instruction in it"),
    ("Praetor blocks PRs waiting for review, but CodeRabbit never produces findings.",
     False, "`never` describing behaviour, not forbidding it — the WEAK bucket"),
    ("The three scripts scan project memory only, never global files.",
     False, "same trap, third-person verb after never"),
    ('The guard decayed when the format changed: the rule "check the cache first" stopped firing.',
     False, "imperative inside a quoted example is not an instruction"),
    ("Knowledge scope is three-layer, not two: project, tool, global.",
     False, "contrast without a verb is not a prescription"),
    ("Tautin's guard had two vulnerabilities. First, the pattern only matched paths.",
     False, "`first` followed by a noun, not by an imperative"),
    ("When an entity's ID is runtime-generated, don't change the lookup direction.",
     True, "apostrophes in ordinary English must not be read as quote delimiters"),
    ("The three scripts (check-links.sh, verify-schema.py, run-audit.sh) scan the tree.",
     False, "a verb inside a filename is not an instruction"),
]


def run_tests(cap: int) -> int:
    print("locator unit tests (synthetic strings, no DB touched)\n")
    bad = 0
    for text, want, why in TEST_CASES:
        _, strong_end, _ = probe(text)
        got = strong_end is not None and strong_end <= cap
        ok = got == want
        bad += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  expect={'action' if want else 'none  '}  "
              f"got={'action' if got else 'none  '}  — {why}")
        if not ok:
            print(f"        text: {text}")
    print()
    if bad:
        print(f"[exit 1] {bad}/{len(TEST_CASES)} locator tests failed", file=sys.stderr)
        return 1
    print(f"{len(TEST_CASES)}/{len(TEST_CASES)} passed")
    return 0


def run_self_check(path: str, cap: int) -> int:
    """Score the probe against human labels. The point is not a high score; it is
    that the score exists and is printed, so nobody has to assume one."""
    if not os.path.exists(path):
        print(f"annotation set not found: {path}\n"
              f"Expected JSON: {{\"labels\": [{{\"id\": <memory id>, \"label\": \"P\"|\"S\"|\"X\"}}]}}\n"
              f"P = a reader could act on the first {cap} chars, S = symptom only, "
              f"X = the memory has no prescription to cut.", file=sys.stderr)
        return 2
    ann = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    labels = {int(r["id"]): r["label"] for r in ann["labels"]}
    db = resolve_db()
    if not os.path.exists(db):
        print(f"DB not found: {db}", file=sys.stderr)
        return 2
    con = sqlite3.connect(pathlib.Path(db).resolve().as_uri() + "?mode=ro", uri=True)
    qs = ",".join("?" * len(labels))
    rows = con.execute(f"SELECT id, content FROM memories WHERE id IN ({qs})", tuple(labels)).fetchall()
    con.close()
    print(f"DB : {db}\n標註集: {path}  ({len(rows)}/{len(labels)} 筆仍在庫中)\n")

    # Scores are reported per draw, never pooled into one headline. The probe's
    # quote-masking and filename guards were both written while staring at draw 1,
    # so draw 1 is a development set and its score is inflated by construction.
    # Draw 2 was labelled after the probe was frozen: recall fell 0.75 -> 0.48 on
    # it. One pooled number would have hidden that entirely.
    draws = {}
    for r in ann["labels"]:
        draws.setdefault(r.get("draw", 1), {})[int(r["id"])] = r["label"]
    borderline = sum(1 for r in ann["labels"] if r.get("borderline"))

    misses = []
    for dno in sorted(draws):
        tp = fp = fn = tn = 0
        for mid, content in rows:
            if mid not in draws[dno]:
                continue
            human = draws[dno][mid]
            if human == "X":
                continue
            _, strong_end, _ = probe(content)
            machine = strong_end is not None and strong_end <= cap
            if human == "P" and machine: tp += 1
            elif human == "P": fn += 1; misses.append((mid, dno, "MISS  human=P machine=none", content[:92]))
            elif machine: fp += 1; misses.append((mid, dno, "FALSE human=S machine=action", content[:92]))
            else: tn += 1
        n = tp + fp + fn + tn
        if not n:
            continue
        prec = tp / (tp + fp) if tp + fp else float("nan")
        rec = tp / (tp + fn) if tp + fn else float("nan")
        role = "開發集(探針照著它調過, 分數偏高)" if dno == 1 else "holdout(探針凍結後才標, 這個才是實力)"
        print(f"draw {dno} — {role}")
        print(f"  n={n}  precision {prec:.2f}   recall {rec:.2f}   accuracy {(tp+tn)/n:.2f}"
              f"   [TP {tp} FP {fp} FN {fn} TN {tn}]")
    if misses:
        print("\n分歧樣本 — 這些是這支探針量不準的形狀, 讀它們比讀分數有用:")
        for mid, dno, kind, head in misses:
            print(f"  [{mid}] draw{dno} {kind}\n         {head}…")
    print(f"\n⚠️  這個分數量的是「探針 vs 人工判讀」, 不是「探針 vs 真相」。人工判讀"
          f"\n    自己有邊界案例({borderline}/{len(ann['labels'])} 筆), 分數的天花板就在那裡。")
    print("⚠️  precision 遠高於 recall 是這支探針的形狀: 它說有動作時通常對, 但漏掉整類"
          "\n    「判斷型處方」(『這條路不可靠』『這個判準在大專案零效用』——無祈使動詞、"
          "\n    無義務情態)。所以主指標的下界是保守的, 真值更靠近人工數字。")
    return 0


def resolve_db() -> str:
    return os.environ.get("CCRECALL_DB_PATH") or os.path.expanduser("~/.ccrecall/ccrecall.db")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="lookback window (default 30)")
    ap.add_argument("--since", help="absolute start date YYYY-MM-DD; overrides --days. "
                                    "Use this to measure only memories written after a "
                                    "prompt change, so pre- and post- samples never mix.")
    ap.add_argument("--until", help="exclusive end date YYYY-MM-DD. Without it a "
                                    "'before the change' run silently includes every "
                                    "row written after it, i.e. the arm it is the control for.")
    ap.add_argument("--cap", type=int, default=DEFAULT_CAP,
                    help=f"per-row char cap surviving truncation (default {DEFAULT_CAP})")
    ap.add_argument("--test", action="store_true", help="run locator unit tests and exit (no DB)")
    ap.add_argument("--self-check", nargs="?", const=DEFAULT_ANNOTATIONS, metavar="PATH",
                    help=f"score the probe against human labels (default {DEFAULT_ANNOTATIONS})")
    args = ap.parse_args()

    if args.test:
        return run_tests(args.cap)
    if args.self_check:
        return run_self_check(args.self_check, args.cap)

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
    if args.until and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.until):
        print(f"--until must be YYYY-MM-DD, got {args.until!r}", file=sys.stderr)
        return 2
    if args.since and args.until and args.until <= args.since:
        print(f"--until {args.until} is not after --since {args.since}: empty window",
              file=sys.stderr)
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
    params: tuple = ()
    if args.until:
        where += " AND date(created_at) < ?"
        params = (args.until,)
    cols = "SELECT id, date(created_at), COALESCE(key,''), content FROM memories WHERE "
    if args.since:
        print(f"窗口: {args.since} 起{' 到 ' + args.until + ' 前' if args.until else ''}"
              f"   |   截斷線: {args.cap} 字元")
        rows = con.execute(cols + where + " AND date(created_at) >= ?",
                           params + (args.since,)).fetchall()
    else:
        print(f"窗口: 近 {args.days} 天{' 到 ' + args.until + ' 前' if args.until else ''}"
              f"   |   截斷線: {args.cap} 字元")
        rows = con.execute(cols + where + " AND date(created_at) >= date('now', ?)",
                           params + (f"-{args.days} days",)).fetchall()
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

    # ── PRIMARY: actionability ─────────────────────────────────────────────────
    probed = [(r, *probe(r[3])) for r in rows]
    strong_in = [(r, s) for r, s, e, _ in probed if e is not None and e <= args.cap]
    strong_any = [(r, s) for r, s, e, _ in probed if s is not None]
    weak_only_in = [r for r, s, e, w in probed
                    if (e is None or e > args.cap) and w is not None and w < args.cap]
    lo = len(strong_in)
    hi = lo + len(weak_only_in)
    print("=== 主指標: 可操作性(前 %d 字元內有沒有可執行動作) ===" % args.cap)
    print(f">>> 送得到(下界, 明確祈使/義務且不在引號內): {lo:4d}/{len(rows)} = {100*lo/len(rows):.1f}%")
    print(f">>> 送得到(上界, 加計語意含糊的 never/cannot/對比句): {hi:4d}/{len(rows)} = {100*hi/len(rows):.1f}%")
    print(f"    區間寬度 {hi-lo} 筆 = 這支探針分辨不了的量, 不是雜訊而是它的解析度上限")
    if strong_any:
        pos = sorted(s for _, s in strong_any)
        print(f"    動作起始位置(全母體有動作者 {len(strong_any)} 筆): 中位 {statistics.median(pos):.0f} / "
              f"最小 {pos[0]} / 最大 {pos[-1]}  =>  中位 = 截斷線的 {statistics.median(pos)/args.cap:.1f}x")
    print()

    # ── LEGACY: marker locator, kept for cross-check ───────────────────────────
    has = [(r, m) for r, m in ((r, RX_MARKER.search(r[3])) for r in rows) if m]
    print("=== 對照口徑(legacy): 明確處方標記 ===")
    print(f"    有明確處方段: {len(has):4d}/{len(rows)} = {100*len(has)/len(rows):.1f}%")
    if has:
        m_in = [(r, m) for r, m in has if m.start(1) < args.cap]
        # m.start() is the offset of the consumed separator, not of the marker; only
        # group 1 is the marker itself. The delta ran 2-3 chars over the live corpus,
        # always UNDER-reporting cuts — harmless at a median offset of 451, but this
        # is the acceptance instrument for a change whose whole purpose is to move
        # prescriptions to just inside the cap, i.e. into exactly the band where a
        # 2-char bias flips the verdict, and it flips it toward "delivered".
        print(f"    其中落在線內: {len(m_in)}/{len(has)} = {100*len(m_in)/len(has):.1f}%")
        mpos = sorted(m.start(1) for _, m in has)
        print(f"    標記位置中位 {statistics.median(mpos):.0f} = 截斷線的 "
              f"{statistics.median(mpos)/args.cap:.1f}x")
    else:
        print("    (0 筆 — 見檔頭: 標籤消失是 #107 的預期後果, 不是處方消失)")
    print()

    # ── The disagreement between the two locators IS the finding ───────────────
    marker_rate = (100 * sum(1 for r, m in has if m.start(1) < args.cap) / len(has)) if has else 0.0
    print("=== 兩個口徑並列 ===")
    print(f"    可操作性(主): {100*lo/len(rows):.1f}% – {100*hi/len(rows):.1f}%   |   "
          f"標記在線內(legacy): {marker_rate:.1f}%")
    if lo > 0 and marker_rate == 0.0:
        print("    🔴 legacy 口徑歸零而主口徑非零 — 這正是 2026-09-12 人工盲審確認的失效模式:")
        print("       處方寫進首句就不再需要 `Mitigation:` 標籤, 標籤消失被 legacy 讀成處方消失。")
        print("       **不要引用 legacy 數字下結論**, 它在這個文體下與事實反向。")
    print()

    untrusted = []
    # Counter-probe: a metric that cannot say "fine" for anything is not measuring.
    verdict = "YES, 主指標有辨別力" if strong_in else "NO — 主指標恆為 FAIL, 結果不可信"
    print(f"[counter-probe] 存在動作落在線內的樣本嗎? {lo} 筆 -> {verdict}")
    if strong_in:
        r, s = min(strong_in, key=lambda x: x[1])
        print(f"  最早動作位置 {s} 字元: {r[2] or r[0]}")
    else:
        untrusted.append("counter-probe 失敗(無線內樣本, 主指標恆為 FAIL)")
    print()

    if strong_any:
        cut = [(r, s) for r, s in strong_any if s >= args.cap]
        if cut:
            print("--- 有動作但落在截斷線後最遠的 8 筆 ---")
            for r, s in sorted(cut, key=lambda x: -x[1])[:8]:
                print(f"  @{s:4d} (全長{len(r[3]):4d})  {r[2] or r[0]}")
            print()

    # A locator that finds an action in nearly every row is not discriminating
    # either; the marker locator's old failure was the mirror image of this one.
    if len(strong_any) / len(rows) > 0.95:
        print("⚠️  >95% 的樣本都被判定為「有動作」— 這支探針可能只是在匹配常用動詞。")
        print("    跑 --self-check 對照人工標籤, 別直接引用上面的百分比。")
        untrusted.append("動作偵測率 >95%(可能失去鑑別力)")
    if len(strong_any) / len(rows) < 0.10:
        print("⚠️  <10% 的樣本被判定為「有動作」— 探針可能對這批語料失效(換了語言或文體)。")
        print("    重跑動詞頻率掃描(見 ACTION_VERBS 註解), 不要用本數字下結論。")
        untrusted.append("動作偵測率 <10%(探針可能對此語料失效)")

    # Exit code tracks trustworthiness, not "did python finish". Every state that
    # prints "do not trust this output" used to return 0, so `script && publish`
    # published precisely the runs the script had disowned.
    if untrusted:
        print(f"[exit 1] 本次輸出不可作為判定依據: {' / '.join(untrusted)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
