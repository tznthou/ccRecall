-- usefulness-report.sql — S1 topic overlap + S2 source breakdown
-- Usage: sqlite3 ~/.ccrecall/ccrecall.db < scripts/usefulness-report.sql
--
-- Positioning: experiment, not metric. Overlap = topic-intersection lower bound
-- for relevance, not usefulness. Tier 1 cold cycling has low overlap by design.
-- This report first needs to show whether overlap has discriminating power at all.

.headers on
.mode column
.width 0 0 0 0 0 0 0

-- ── Data quality gate ──────────────────────────────────────────────

SELECT '── DATA QUALITY GATE ──' AS '';

SELECT
  COUNT(*)                                                         AS total_rows,
  SUM(CASE WHEN session_id IS NULL THEN 1 ELSE 0 END)             AS null_session,
  printf('%.1f%%',
    100.0 * SUM(CASE WHEN session_id IS NULL THEN 1 ELSE 0 END)
          / MAX(COUNT(*), 1))                                      AS null_pct,
  CASE
    WHEN 100.0 * SUM(CASE WHEN session_id IS NULL THEN 1 ELSE 0 END)
               / MAX(COUNT(*), 1) > 20
    THEN 'WARN >20% — overlap unreliable'
    ELSE 'OK'
  END                                                              AS verdict
FROM injection_log;

-- ── Coverage ───────────────────────────────────────────────────────

SELECT '── COVERAGE ──' AS '';

SELECT
  MIN(injected_at)              AS first,
  MAX(injected_at)              AS last,
  CAST(julianday(MAX(injected_at)) - julianday(MIN(injected_at)) AS INTEGER) AS span_days,
  COUNT(DISTINCT memory_id)     AS distinct_memories,
  COUNT(DISTINCT session_id)    AS distinct_sessions
FROM injection_log;

-- ── Overlap distribution ───────────────────────────────────────────

SELECT '── OVERLAP DISTRIBUTION ──' AS '';

WITH base AS (
  SELECT il.memory_id, il.session_id, il.source,
         COUNT(st.topic_key) AS overlap
  FROM injection_log il
  LEFT JOIN memory_topics  mt ON mt.memory_id = il.memory_id
  LEFT JOIN session_topics st ON st.session_id = il.session_id
                              AND st.topic_key = mt.topic_key
  WHERE il.session_id IS NOT NULL
  GROUP BY il.memory_id, il.session_id, il.source
),
bucketed AS (
  SELECT *,
    CASE
      WHEN overlap = 0           THEN 0
      WHEN overlap BETWEEN 1 AND 2 THEN 1
      WHEN overlap BETWEEN 3 AND 5 THEN 2
      ELSE                            3
    END AS bucket
  FROM base
)
SELECT
  CASE bucket
    WHEN 0 THEN '0 (none)'
    WHEN 1 THEN '1-2'
    WHEN 2 THEN '3-5'
    WHEN 3 THEN '6+'
  END                                                    AS overlap_range,
  COUNT(*)                                               AS injections,
  printf('%.1f%%', 100.0 * COUNT(*) / (SELECT COUNT(*) FROM base)) AS pct
FROM bucketed
GROUP BY bucket
ORDER BY bucket;

-- ── Per-source overlap (S2) ────────────────────────────────────────

SELECT '── PER-SOURCE OVERLAP ──' AS '';

WITH base AS (
  SELECT il.memory_id, il.session_id, il.source,
         COUNT(st.topic_key) AS overlap
  FROM injection_log il
  LEFT JOIN memory_topics  mt ON mt.memory_id = il.memory_id
  LEFT JOIN session_topics st ON st.session_id = il.session_id
                              AND st.topic_key = mt.topic_key
  WHERE il.session_id IS NOT NULL
  GROUP BY il.memory_id, il.session_id, il.source
)
SELECT
  source,
  COUNT(*)                 AS injections,
  printf('%.2f', AVG(overlap)) AS avg_overlap,
  MIN(overlap)             AS min_ov,
  MAX(overlap)             AS max_ov,
  SUM(CASE WHEN overlap = 0 THEN 1 ELSE 0 END) AS zero_ct
FROM base
GROUP BY source
ORDER BY injections DESC;

-- ── Top memories by injection count ────────────────────────────────

SELECT '── TOP 10 MOST INJECTED ──' AS '';

SELECT
  il.memory_id                                       AS id,
  COUNT(*)                                           AS inj_ct,
  COUNT(DISTINCT il.session_id)                      AS sessions,
  substr(m.content, 1, 60)                           AS content_preview
FROM injection_log il
JOIN memories m ON m.id = il.memory_id
GROUP BY il.memory_id
ORDER BY inj_ct DESC
LIMIT 10;
