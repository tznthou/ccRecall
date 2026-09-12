#!/usr/bin/env python3
"""L3 measurement — can a reader act on the part of a memory that survives the
per-row truncation applied before startup/prompt injection?

Background: token-budget.ts truncates each injected row to DEFAULT_PER_ROW_CHAR_CAP
chars. If the "what to do next" part of a memory sits past that cut, the memory is
delivered as a symptom report with no prescription — surfaced, but not actionable.

Usage:
    python3 scripts/l3-prescription-position.py [--days 30 | --since YYYY-MM-DD]
                                               [--until YYYY-MM-DD] [--cap 149]
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
import datetime
import json
import os
import pathlib
import re
import sqlite3
import statistics
import sys
from typing import NamedTuple, Optional

# token-budget.ts DEFAULT_PER_ROW_CHAR_CAP = 150; truncateToChars keeps
# maxChars - 1 chars and appends an ellipsis, so 149 is what actually survives.
# Duplicated rather than read from the TypeScript source: parsing TS from Python
# to recover one integer is more failure surface than the drift it prevents, and
# it would fail silently. The TS side is the SSOT — if this ever disagrees with
# token-budget.ts, that file wins; tests/extraction-prompt-prescription.test.ts
# imports the constant live and will catch a change there.
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
# The trailing guard is `(?![\w.-])`, not `\b`: this corpus is full of tool names
# built from these very verbs, and a comma-separated list of them looks exactly
# like a comma-separated list of instructions: "the three scripts
# (check-links.sh, verify-schema.py) scan the tree" scored as actionable under
# `\b`, because `check` sat after ", " and ended at a hyphen, which `\b` accepts.
# A verb followed by `-` or `.` is a filename or a flag, not an instruction. The
# dot has one side effect worth knowing: a sentence-final imperative ("…, verify.")
# is dropped. Measured at 0 affected rows in the live corpus, so it stays rather
# than being traded back for filename false positives.
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


class Signals(NamedTuple):
    """Where the first STRONG and first WEAK signal sit, plus the text after the
    STRONG one so a caller can ask whether anything followed it inside the cap."""
    strong_start: Optional[int]
    strong_end: Optional[int]
    weak_start: Optional[int]
    weak_end: Optional[int]
    tail: str


# An instruction is not delivered by its verb alone. "…, must" and "…, verify"
# both end at 148 with a cap of 149, and the reader gets the word with nothing to
# apply it to — no object, and in the first case not even the negation. So a verb
# counts as delivered only when some of what follows it also survives the cut.
#
# Three characters is a judgement, not a measurement: the shortest run that can
# carry a word rather than a fragment ("it", "DB", "all"). Its effect on the live
# corpus was measured before it went in, and the honest answer is ZERO: across the
# 430 rows of the 30-day window the delivered count is 91 at every threshold from
# 0 to 8, and 91 under the old verb-end-only rule too. No stored row currently has
# a verb straddling the cut. So this guard changes no number reported today — it
# is defensive, kept because the failure is real (reproducible on synthetic input,
# see TEST_CASES) and because when it did occur it would be invisible.
# Re-measure before changing it rather than reasoning about it.
MIN_OBJECT_CHARS = 3

# Cap on how many raw memory excerpts --self-check prints in one run.
MAX_MISSES_PRINTED = 12


def probe(text: str) -> Signals:
    """Locate the first actionable instruction.

    STRONG ignores quoted spans; WEAK does not. Both carry an end offset, because
    a signal that merely starts inside the cap can still be cut in half — the
    reason `delivered()` exists rather than a comparison written out at each call
    site. The three call sites used to write it out, in three different ways.
    """
    masked = mask_quotes(text)
    hits = [(m.start(1), m.end(1))
            for m in (RX_IMPERATIVE.search(masked), RX_OBLIGATION.search(masked)) if m]
    s_start, s_end = min(hits) if hits else (None, None)
    w = RX_WEAK.search(text)
    return Signals(s_start, s_end, w.start(1) if w else None, w.end(1) if w else None,
                   text[s_end:] if s_end is not None else "")


def delivered(sig: Signals, cap: int) -> bool:
    """Did an instruction, and enough of what it acts on, survive truncation?"""
    if sig.strong_end is None or sig.strong_end > cap:
        return False
    return len(sig.tail[: cap - sig.strong_end].strip()) >= MIN_OBJECT_CHARS


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
    ("The merge gate blocks PRs waiting for review, but the bot never produces findings.",
     False, "`never` describing behaviour, not forbidding it — the WEAK bucket"),
    ("The three scripts scan project memory only, never global files.",
     False, "same trap, third-person verb after never"),
    ('The guard decayed when the format changed: the rule "check the cache first" stopped firing.',
     False, "imperative inside a quoted example is not an instruction"),
    ("Knowledge scope is three-layer, not two: project, tool, global.",
     False, "contrast without a verb is not a prescription"),
    ("The guard had two vulnerabilities. First, the pattern only matched paths.",
     False, "`first` followed by a noun, not by an imperative"),
    ("When an entity's ID is runtime-generated, don't change the lookup direction.",
     True, "apostrophes in ordinary English must not be read as quote delimiters"),
    ("The three scripts (check-links.sh, verify-schema.py, run-audit.sh) scan the tree.",
     False, "a verb inside a filename is not an instruction"),
    ("x" * 142 + ". must not delete the database.",
     False, "modal ends at 148 of 149: the reader gets `. must ` — verb, no object, "
            "not even the negation"),
    ("z" * 140 + ". verify the cache invalidation path.",
     False, "same shape with an imperative: `. verify ` alone is not actionable"),
]


# Argument validation cases. Every one of these was a real defect: the window
# flags accepted values that made the filter a no-op rather than an error.
ARG_CASES = [
    # (kwargs, expect_error, why)
    (dict(since="2026-09-09"), False, "a well-formed --since is accepted"),
    (dict(since="２０２６-０９-０９"), True,
     "fullwidth digits: \\d is Unicode-aware, and BINARY collation then sorts them "
     "above every ASCII date, turning the predicate into a no-op"),
    (dict(until="２０２６-０９-０９"), True, "same for --until"),
    (dict(since="2026-13-45"), True, "shape is right, calendar date does not exist"),
    (dict(until="2026-02-30"), True, "same, and February makes it look plausible"),
    (dict(since="2026-09-09", until="2026-09-09"), True, "empty window: until is exclusive"),
    (dict(since="2026-09-10", until="2026-09-09"), True, "until before since"),
    (dict(cap=0), True, "cap 0 divides by zero halfway through the report"),
    (dict(cap=-5), True, "negative cap blames the metric for a bad flag"),
    (dict(days=-30), True, "negative lookback makes date() NULL and empties the window"),
]


def _run_arg_cases() -> int:
    print("argument validation")
    bad = 0
    for kwargs, want_err, why in ARG_CASES:
        args = dict(days=30, since=None, until=None, cap=DEFAULT_CAP)
        args.update(kwargs)
        got = validate_args(**args) is not None
        ok = got == want_err
        bad += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  expect={'reject' if want_err else 'accept'}  "
              f"got={'reject' if got else 'accept'}  — {why}")
    return bad


def _run_scoring_cases() -> int:
    """The scorer decides whether the probe's error rate is believable, so its own
    failure modes are the ones that silently launder a bad number into a good one."""
    print("\nself-check scoring")
    bad = 0
    # A row a human said has no prescription at all, which the probe nonetheless
    # calls actionable ("never run" matches the obligation pattern), is a false
    # positive. Dropping X rows hides exactly the over-matching this scorer exists
    # to expose.
    cases = [
        ([("X", "The scripts never run automatically.")], (0, 1, 0, 0),
         "X row the probe calls actionable is a false positive, not a skipped row"),
        ([("X", "Rotation rewrites the content after seven days.")], (0, 0, 0, 1),
         "X row the probe leaves alone is a true negative"),
        ([("P", "Verify the cache before shipping.")], (1, 0, 0, 0), "plain true positive"),
        ([("S", "The daemon holds the connection open.")], (0, 0, 0, 1), "plain true negative"),
    ]
    for labels, want, why in cases:
        got = score_draw([(i, lab, txt) for i, (lab, txt) in enumerate(labels)], DEFAULT_CAP)[:4]
        ok = got == want
        bad += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  expect(tp,fp,fn,tn)={want} got={got}  — {why}")
    # An unrecognised label must not be silently folded into the negative bucket:
    # that can only make recall look better than it is.
    rejected = score_draw([(1, "p", "Verify the cache.")], DEFAULT_CAP)
    ok = rejected[4] == 1 and sum(rejected[:4]) == 0
    bad += not ok
    print(f"  {'PASS' if ok else 'FAIL'}  expect=skipped+counted  got=skipped:{rejected[4]} "
          f"scored:{sum(rejected[:4])}  — a typo'd label is reported, never scored as S")
    return bad


def _run_verdict_cases() -> int:
    """main() refuses to exit 0 while printing "do not trust this"; run_self_check
    used to print exactly that and exit 0 anyway. These pin the parity."""
    print("\nself-check trustworthiness")
    bad = 0
    cases = [
        (dict(scored=40, skipped=0, rewritten=0, tp=15, fp=1), False,
         "a normal scored run is trustworthy"),
        (dict(scored=0, skipped=0, rewritten=0, tp=0, fp=0), True,
         "no scored rows at all"),
        (dict(scored=1, skipped=0, rewritten=0, tp=0, fp=1), True,
         "all-X file: scored>0 now that X counts as a negative, so the zero-row "
         "guard misses it, and precision is 0.00 while the footer claims it is high"),
        (dict(scored=1, skipped=0, rewritten=0, tp=0, fp=0), True,
         "precision undefined (no positive predictions) is not the same as precision 1.0"),
        (dict(scored=40, skipped=0, rewritten=1, tp=15, fp=1), True,
         "a row the compressor rewrote is no longer the text the human labelled"),
        (dict(scored=40, skipped=3, rewritten=0, tp=15, fp=1), True,
         "labels that could not be read at all"),
    ]
    for kwargs, want, why in cases:
        got = bool(self_check_verdict(**kwargs))
        ok = got == want
        bad += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  expect={'untrusted' if want else 'ok       '}  "
              f"got={'untrusted' if got else 'ok       '}  — {why}")
    return bad


def _run_legacy_diagnosis_cases() -> int:
    """0.0% in-cap has two causes with opposite meanings, and the warning text used
    to assert the one that happens to flatter the change being measured."""
    print("\nlegacy locator diagnosis")
    bad = 0
    cases = [
        (0, 0, "absent", "no markers at all — labels gone, which is what #107 predicts"),
        (0, 17, "late", "17 markers present but every one past the cap — labels present, late"),
        (3, 17, "some", "some markers inside the cap"),
    ]
    for n_in, n_has, want, why in cases:
        got = legacy_diagnosis(n_in, n_has)
        ok = got == want
        bad += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  expect={want:<7} got={got:<7} — {why}")
    return bad


def run_tests(cap: int) -> int:
    print("locator unit tests (synthetic strings, no DB touched)\n")
    bad = 0
    # DEFAULT_CAP, not the caller's --cap: every case here is a property of the
    # locator ("a verb inside a filename is not an instruction"), and none of the
    # strings is long enough for the cap to be the thing under test. Honouring
    # --cap here only manufactured failures — `--test --cap 40` reported two
    # broken locator cases while the locator was fine.
    for text, want, why in TEST_CASES:
        got = delivered(probe(text), DEFAULT_CAP)
        ok = got == want
        bad += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  expect={'action' if want else 'none  '}  "
              f"got={'action' if got else 'none  '}  — {why}")
        if not ok:
            print(f"        text: {text}")
    total = len(TEST_CASES)
    bad += _run_arg_cases();          total += len(ARG_CASES)
    bad += _run_scoring_cases();      total += 5
    bad += _run_legacy_diagnosis_cases(); total += 3
    bad += _run_verdict_cases();          total += 6
    print()
    if bad:
        print(f"[exit 1] {bad}/{total} tests failed", file=sys.stderr)
        return 1
    print(f"{total}/{total} passed")
    return 0


def run_self_check(path: str, cap: int) -> int:
    """Score the probe against human labels. The point is not a high score; it is
    that the score exists and is printed, so nobody has to assume one."""
    if not os.path.exists(path):
        print(f"annotation set not found: {path}\n"
              f"Expected JSON: {{\"cap\": <int>, \"labels\": [{{\"id\": <memory id>, "
              f"\"label\": \"P\"|\"S\"|\"X\"}}]}}\n"
              f"P = a reader could act on the first N chars, S = symptom only, "
              f"X = the memory has no prescription to cut.", file=sys.stderr)
        return 2
    # A hostile or half-written annotation file must fail with a sentence, the way
    # every other bad input to this script does, not with a traceback.
    try:
        ann = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        entries = [(int(r["id"]), r["label"], int(r.get("draw", 1))) for r in ann["labels"]]
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        print(f"annotation set at {path} is not usable: {exc}", file=sys.stderr)
        return 2

    # The labels were written against a specific cap and the file records it.
    # Scoring probe@60 against human@149 compares two different questions, and
    # the old code did it silently while relabelling the humans' criteria with
    # whatever --cap the caller happened to pass.
    label_cap = ann.get("cap")
    if label_cap is not None and label_cap != cap:
        print(f"--cap {cap} does not match the cap the labels were made at ({label_cap}). "
              f"Scoring the probe at one cap against humans reading another measures "
              f"nothing. Re-run without --cap, or re-label.", file=sys.stderr)
        return 2

    db = resolve_db()
    if not os.path.exists(db):
        print(f"DB not found: {db}", file=sys.stderr)
        return 2
    con = sqlite3.connect(pathlib.Path(db).resolve().as_uri() + "?mode=ro", uri=True)
    ids = [e[0] for e in entries]
    qs = ",".join("?" * len(ids)) if ids else "NULL"
    rows = dict(con.execute(f"SELECT id, content FROM memories WHERE id IN ({qs})", tuple(ids)))
    # compression_level is not in the population predicate here the way it is in
    # main(), because the labels name specific rows. But rotation rewrites content
    # in place at L1, so a row can still be present and no longer be the text the
    # human read. Report it rather than scoring the compressor's prose against a
    # human label written about the original.
    rewritten = [i for i, in con.execute(
        f"SELECT id FROM memories WHERE compression_level > 0 AND id IN ({qs})", tuple(ids))] if ids else []
    con.close()
    print(f"DB : {db}\n標註集: {path}  ({len(rows)}/{len(entries)} 筆仍在庫中)")
    if rewritten:
        print(f"⚠️  {len(rewritten)} 筆已被壓縮器改寫(compression_level > 0) — 這些的 content "
              f"不再是人工當時讀的文字, 分數已不可比: {rewritten[:8]}")
    print()

    # Scores are reported per draw, never pooled into one headline. The probe's
    # quote-masking and filename guards were both written while staring at draw 1,
    # so draw 1 is a development set and its score is inflated by construction.
    # Draw 2 was labelled after the probe was frozen: recall fell 0.75 -> 0.48 on
    # it. One pooled number would have hidden that entirely.
    draws = {}
    for mid, label, dno in entries:
        draws.setdefault(dno, []).append((mid, label))
    borderline = sum(1 for r in ann["labels"] if r.get("borderline"))

    # Rewritten rows are dropped, not merely announced. Scoring them compares the
    # probe against compressor prose while the label describes text that no longer
    # exists, and the previous version printed "分數已不可比" and then went ahead
    # and computed the score anyway.
    stale = set(rewritten)
    misses, scored_total, skipped_total, tp_total, fp_total = [], 0, 0, 0, 0
    for dno in sorted(draws):
        present = [(mid, lab, rows[mid]) for mid, lab in draws[dno]
                   if mid in rows and mid not in stale]
        tp, fp, fn, tn, skipped, ms = score_draw(present, cap)
        misses += [(mid, dno, kind, head) for mid, _, kind, head in ms]
        n = tp + fp + fn + tn
        scored_total += n
        skipped_total += skipped
        tp_total += tp
        fp_total += fp
        if not n:
            print(f"draw {dno} — 0 筆可計分(標籤不在庫中或全部無法辨識), 本 draw 無分數")
            continue
        prec = tp / (tp + fp) if tp + fp else float("nan")
        rec = tp / (tp + fn) if tp + fn else float("nan")
        role = "開發集(探針照著它調過, 分數偏高)" if dno == 1 else "holdout(探針凍結後才標, 這個才是實力)"
        print(f"draw {dno} — {role}")
        print(f"  n={n}  precision {prec:.2f}   recall {rec:.2f}   accuracy {(tp+tn)/n:.2f}"
              f"   [TP {tp} FP {fp} FN {fn} TN {tn}]"
              + (f"  ⚠️ {skipped} 筆標籤無法辨識, 未計分" if skipped else ""))

    if misses:
        # These are excerpts of the user's own stored memories. main() prints only
        # the dedup key for the same reason — this project has pasted dogfood
        # output into public issues before.
        print("\n分歧樣本 — 這些是這支探針量不準的形狀, 讀它們比讀分數有用:")
        print("⚠️  以下含記憶原文片段, 貼進公開 issue / PR 前先去識別化。")
        for mid, dno, kind, head in misses[:MAX_MISSES_PRINTED]:
            print(f"  [{mid}] draw{dno} {kind}\n         {head}…")
        if len(misses) > MAX_MISSES_PRINTED:
            print(f"  … 另有 {len(misses) - MAX_MISSES_PRINTED} 筆未列出")

    untrusted = self_check_verdict(scored_total, skipped_total, len(stale),
                                   tp_total, fp_total)
    print(f"\n⚠️  這個分數量的是「探針 vs 人工判讀」, 不是「探針 vs 真相」。人工判讀"
          f"\n    自己有邊界案例({borderline}/{len(entries)} 筆), 分數的天花板就在那裡。")
    # Gated, never asserted: the previous version printed "precision 遠高於
    # recall" unconditionally, including over a population where precision was
    # 0.00. A claim about measured numbers only gets printed when this run's
    # numbers actually support it, which is what self_check_verdict decides.
    if untrusted:
        print(f"\n[exit 1] 本次 self-check 不可作為判定依據: {' / '.join(untrusted)}",
              file=sys.stderr)
        return 1
    print("📌 這支探針的已知形狀(來自上面的實測, 不是預設): precision 高於 recall — 它說"
          "\n    有動作時通常對, 但漏掉整類「判斷型處方」(『這條路不可靠』『這個判準在大專案"
          "\n    零效用』——無祈使動詞、無義務情態)。所以主指標偏低而非偏高。")
    return 0


def validate_args(days: int, since: Optional[str], until: Optional[str],
                  cap: int) -> Optional[str]:
    """Reject every window/cap value that would mislead rather than fail.

    Each rule here is a defect that shipped: the flags failed silently, and in
    opposite directions, so the reader saw a plausible number computed over the
    wrong rows.
    """
    for name, value in (("--since", since), ("--until", until)):
        if value is None:
            continue
        # [0-9], not \d: Python's \d is Unicode-aware, so U+FF10-FF19 pass the
        # shape check. SQLite then compares BINARY, where a fullwidth digit sorts
        # above every ASCII date — `date(created_at) < '２０２６-…'` is true for
        # every row, and the flag whose whole job is to separate the control arm
        # from the treatment arm becomes a no-op that still exits 0.
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
            return (f"{name} must be YYYY-MM-DD in ASCII digits, got {value!r} — SQLite "
                    f"compares created_at lexically, so a malformed value silently "
                    f"measures the wrong population")
        # Shape is not a date: 2026-13-45 and 2026-02-30 both match the pattern.
        try:
            datetime.date.fromisoformat(value)
        except ValueError:
            return f"{name}={value!r} is not a real calendar date"
    if since and until and until <= since:
        return (f"--until {until} is not after --since {since}: --until is exclusive, "
                f"so this window is empty")
    if days <= 0:
        return (f"--days must be positive, got {days} — a negative modifier makes "
                f"date() return NULL and every row falls outside the window")
    if cap <= 0:
        return (f"--cap must be positive, got {cap} — cap 0 divides by zero midway "
                f"through the report, and a negative cap reports 'counter-probe "
                f"failed', blaming the metric for a bad flag")
    return None


def legacy_diagnosis(n_in_cap: int, n_located: int) -> str:
    """Why is the legacy in-cap rate 0%? Two causes, opposite meanings.

    'absent'  — no markers anywhere: labels are gone, which is what leading with
                the prescription predicts, and the reading the old warning gave.
    'late'    — markers present, all past the cap: labels are NOT gone, they are
                late. The old text asserted 'absent' here too, which contradicted
                the '有明確處方段: 17/90' line printed four lines above it.
    """
    if not n_located:
        return "absent"
    return "late" if n_in_cap == 0 else "some"


def self_check_verdict(scored: int, skipped: int, rewritten: int,
                       tp: int, fp: int) -> list:
    """Reasons this self-check cannot be used as evidence. Empty means it can.

    main() has had this shape since the rewrite: print the numbers, then refuse
    to exit 0 while also printing "do not trust this output". run_self_check
    printed the disclaimer and exited 0 regardless — and it is the escape hatch
    the main path tells operators to run when the probe looks broken, so it is
    the one place that must not be able to certify itself.
    """
    reasons = []
    if not scored:
        reasons.append("0 筆可計分")
    # An all-X annotation file stopped being a zero-row case the moment X rows
    # became negatives: it scores, reports precision 0.00, and used to reach the
    # footer that asserts precision is far above recall.
    elif tp + fp == 0:
        reasons.append("探針一次都沒說「有動作」⇒ precision 無定義, 不是 1.0")
    elif tp == 0:
        reasons.append(f"precision 0.00 (FP {fp}, TP 0) ⇒ 沒有任何一次判對")
    if rewritten:
        reasons.append(f"{rewritten} 筆已被壓縮器改寫 ⇒ 評的不是人工讀過的文字")
    if skipped:
        reasons.append(f"{skipped} 筆標籤無法辨識")
    return reasons


def score_draw(rows, cap: int):
    """Score one draw. Returns (tp, fp, fn, tn, skipped, misses).

    X rows — a human saying "this memory has no prescription to cut" — are scored
    as negatives, not skipped. A probe that calls such a row actionable is
    over-matching, and over-matching is the failure this scorer exists to expose;
    dropping the rows meant the one class most likely to produce a false positive
    could never appear in the denominator.
    """
    tp = fp = fn = tn = skipped = 0
    misses = []
    for mid, human, content in rows:
        if human not in ("P", "S", "X"):
            # Never fold an unrecognised label into the negative bucket: a typo'd
            # "p" would move a true positive the probe missed out of fn and into
            # tn, which can only make recall look better than it is.
            skipped += 1
            misses.append((mid, None, f"SKIP  unrecognised label {human!r}", content[:92]))
            continue
        machine = delivered(probe(content), cap)
        if human == "P" and machine: tp += 1
        elif human == "P": fn += 1; misses.append((mid, None, "MISS  human=P machine=none", content[:92]))
        elif machine: fp += 1; misses.append((mid, None, f"FALSE human={human} machine=action", content[:92]))
        else: tn += 1
    return tp, fp, fn, tn, skipped, misses


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

    err = validate_args(args.days, args.since, args.until, args.cap)
    if err:
        print(err, file=sys.stderr)
        return 2

    db = resolve_db()
    if not os.path.exists(db):
        print(f"DB not found: {db}", file=sys.stderr)
        return 2
    print(f"DB : {db}")
    # as_uri() percent-escapes the path. Interpolating it raw let a `?` or `#` in
    # the path truncate the URI, discarding `mode=ro` — which opens read-write and
    # CREATES the file, in an application whose first rule is that it never writes.
    #
    # `mode=ro` is not a total write guarantee for a WAL database: per SQLite's WAL
    # documentation a read-only connection may create the -shm/-wal sidecars when
    # they do not already exist and the directory is writable. In practice the
    # daemon holds a connection open and they always do. `immutable=1` would close
    # the gap and is deliberately NOT used: it asserts the file never changes,
    # which is false for a live database and would trade a theoretical write for
    # silently stale reads — the worse failure for a measurement tool.
    con = sqlite3.connect(pathlib.Path(db).resolve().as_uri() + "?mode=ro", uri=True)
    # The population has to match what the injection path can actually select, or
    # the headline describes memories no session will ever be shown:
    #   - type/confidence mirror the Tier 0 filters inside getStartupMemories in
    #     src/core/database.ts (grep the predicate; line numbers in a 2600-line
    #     file rot faster than the code does).
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
    probed = [(r, probe(r[3])) for r in rows]
    strong_in = [(r, sig.strong_start) for r, sig in probed if delivered(sig, args.cap)]
    strong_any = [(r, sig.strong_start) for r, sig in probed if sig.strong_start is not None]
    # The upper bound uses weak_END for the same reason the lower bound uses
    # strong_end: a hedge word cut in half is not delivered either.
    weak_only_in = [r for r, sig in probed
                    if not delivered(sig, args.cap)
                    and sig.weak_end is not None and sig.weak_end <= args.cap]
    lo = len(strong_in)
    hi = lo + len(weak_only_in)
    print("=== 主指標: 可操作性(前 %d 字元內有沒有可執行動作) ===" % args.cap)
    print(f">>> 強訊號率(明確祈使/義務, 且不在引號內): {lo:4d}/{len(rows)} = {100*lo/len(rows):.1f}%")
    print(f"    強或弱訊號率(加計語意含糊的 never/cannot/對比句): {hi:4d}/{len(rows)} = {100*hi/len(rows):.1f}%")
    # Deliberately NOT called a lower and upper bound. Bounds would require the
    # errors to run one way, and they run both:
    #   · ACTION_VERBS is a 17-verb list harvested from this corpus, so ordinary
    #     imperatives outside it ("Restart the daemon…", "Delete the stale
    #     lockfile…") land in neither figure — the human-labelled holdout puts
    #     recall at 0.48, i.e. about half the real instructions are missed.
    #   · `never <verb>` inflates the strong figure on descriptive sentences;
    #     that false positive is test case "same trap, third-person verb after
    #     never" and it is a known, not a hypothetical, over-count.
    # So the gap between the two is a signal-strength split, not a resolution
    # limit, and neither figure brackets the truth on its own.
    print(f"    兩者相差 {hi-lo} 筆 — 這是訊號強度的分界, **不是**誤差界: 探針兩側都會錯"
          f"(holdout recall 0.48 漏掉一半, `never <verb>` 則高估), 見 --self-check")
    if strong_any:
        pos = sorted(s for _, s in strong_any)
        print(f"    動作起始位置(全母體有動作者 {len(strong_any)} 筆): 中位 {statistics.median(pos):.0f} / "
              f"最小 {pos[0]} / 最大 {pos[-1]}  =>  中位 = 截斷線的 {statistics.median(pos)/args.cap:.1f}x")
    print()

    # ── LEGACY: marker locator, kept for cross-check ───────────────────────────
    has = [(r, m) for r, m in ((r, RX_MARKER.search(r[3])) for r in rows) if m]
    # One expression for one concept: this used to be computed here and again at
    # the side-by-side print, so a change to the comparison below would have
    # fixed one copy and left the two printed lines contradicting each other.
    m_in = [(r, m) for r, m in has if m.start(1) < args.cap]
    print("=== 對照口徑(legacy): 明確處方標記 ===")
    print(f"    有明確處方段: {len(has):4d}/{len(rows)} = {100*len(has)/len(rows):.1f}%")
    if has:
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
    marker_rate = (100 * len(m_in) / len(has)) if has else 0.0
    diagnosis = legacy_diagnosis(len(m_in), len(has))
    print("=== 兩個口徑並列 ===")
    print(f"    可操作性(主): {100*lo/len(rows):.1f}% – {100*hi/len(rows):.1f}%   |   "
          f"標記在線內(legacy): {marker_rate:.1f}%")
    if lo > 0 and diagnosis == "absent":
        print("    🔴 legacy 找不到任何標記, 而主口徑非零 — 2026-09-12 人工盲審確認的失效模式:")
        print("       處方寫進首句就不再需要 `Mitigation:` 標籤, 標籤消失被 legacy 讀成處方消失。")
        print("       **不要引用 legacy 數字下結論**, 它在這個文體下與事實反向。")
    elif lo > 0 and diagnosis == "late":
        mpos = statistics.median(sorted(m.start(1) for _, m in has))
        print(f"    🔴 legacy 歸零的原因不是標記消失 — {len(has)} 筆帶標記, 中位落在 {mpos:.0f} 字元,")
        print("       全部在截斷線之後。legacy 量的是**標記位置**不是可操作性, 兩者在這批語料上")
        print("       已經脫鉤。**不要引用 legacy 數字下結論**。")
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
        # The complement of strong_in, not a third rule: under `s >= cap` a row
        # whose verb straddles the cut (start 145, end 151) appeared in neither
        # list and silently left the report.
        _in = {id(r) for r, _ in strong_in}
        cut = [(r, s) for r, s in strong_any if id(r) not in _in]
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
