#!/usr/bin/env bash
# ccRecall post-session extraction wrapper
# Source this file in ~/.zshrc or ~/.bashrc:
#   source /path/to/ccRecall/scripts/post-session-extract.sh
#
# Usage: ccrecall-extract [claude args...]
#   Runs Claude Code with ccRecall startup injection, then extracts
#   memories via Haiku after the session ends.
#
# Environment:
#   CCRECALL_PORT         — daemon port (default 3177)
#   CCRECALL_SKIP_EXTRACT — set to 1 to skip post-session extraction
#   CCRECALL_EXTRACT_LOG  — telemetry log path (default ~/.ccrecall/extract.log.jsonl)

CCRECALL_PORT="${CCRECALL_PORT:-3177}"
CCRECALL_EXTRACT_LOG="${CCRECALL_EXTRACT_LOG:-$HOME/.ccrecall/extract.log.jsonl}"

# Resolve the directory containing this script (for prompt file)
CCRECALL_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ccrecall-extract() {
  local project_id
  project_id=$(echo "$PWD" | sed 's|/|-|g')

  # ── Phase 1: Start session with memory injection ──
  CCRECALL_SESSION_START_STRATEGY=startup-v1 claude --dangerously-skip-permissions "$@"
  local claude_exit=$?

  # ── Phase 2: Post-session memory extraction ──
  if [[ "${CCRECALL_SKIP_EXTRACT:-0}" == "1" ]]; then
    return $claude_exit
  fi

  # Health check — skip extraction if daemon is not running
  if ! curl -sf "http://127.0.0.1:${CCRECALL_PORT}/health" > /dev/null 2>&1; then
    printf '\n⚠️  ccRecall daemon not running (port %s) — skipping extraction.\n' "$CCRECALL_PORT"
    return $claude_exit
  fi

  # Fetch last session metadata for telemetry
  local session_meta
  session_meta=$(curl -sf "http://127.0.0.1:${CCRECALL_PORT}/session/last?cwd=$(printf '%s' "$PWD" | jq -sRr @uri)" 2>/dev/null)
  local session_id=""
  if [[ -n "$session_meta" ]]; then
    session_id=$(echo "$session_meta" | jq -r '.sessionId // empty' 2>/dev/null)
  fi

  # Load the structured prompt
  local prompt_file="${CCRECALL_SCRIPT_DIR}/extraction-prompt.md"
  local prompt
  if [[ -f "$prompt_file" ]]; then
    prompt=$(cat "$prompt_file")
  else
    prompt="You are a memory extraction agent. Save 0-5 lasting insights via recall_save. Each memory must be self-contained with a key slug for dedup. Set projectId to \"${project_id}\" for project-specific knowledge; omit for cross-project knowledge."
  fi

  # Append runtime context (projectId) to the prompt
  prompt="${prompt}

## Runtime context
- projectId for this project: \"${project_id}\"
- Current date: $(date -u +%Y-%m-%d)"

  printf '\n🧠 ccRecall: extracting memories from session...\n'

  local extract_start
  extract_start=$(date +%s)

  command claude -c -p \
    --no-session-persistence \
    --model haiku \
    --max-budget-usd 0.10 \
    --max-turns 5 \
    --dangerously-skip-permissions \
    "$prompt" 2>/dev/null

  local extract_exit=$?
  local extract_end
  extract_end=$(date +%s)
  local extract_duration=$(( extract_end - extract_start ))

  if [[ $extract_exit -eq 0 ]]; then
    printf '✅ ccRecall: extraction complete (%ds).\n' "$extract_duration"
  else
    printf '⚠️  ccRecall: extraction exited with code %d (%ds).\n' "$extract_exit" "$extract_duration"
  fi

  # Telemetry log (jq for proper JSON escaping of arbitrary strings)
  mkdir -p "$(dirname "$CCRECALL_EXTRACT_LOG")"
  jq -n \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg sid "$session_id" \
    --arg pid "$project_id" \
    --argjson exit "$extract_exit" \
    --argjson dur "$extract_duration" \
    '{"ts":$ts,"sessionId":$sid,"projectId":$pid,"exitCode":$exit,"durationSec":$dur}' \
    >> "$CCRECALL_EXTRACT_LOG"

  return $claude_exit
}
