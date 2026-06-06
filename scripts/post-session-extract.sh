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

  # ── Build session transcript from JSONL ──
  # Text-only extraction is ~50x smaller than full JSONL
  # (tool calls, tool results, thinking blocks omitted)
  local transcript_mode="continue"
  local full_prompt=""

  # A4: validate session_id is a UUID before using in filesystem path
  local claude_data_dir="${HOME}/.claude"
  if [[ -n "$session_id" && "$session_id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then
    local jsonl_path="${claude_data_dir}/projects/${project_id}/${session_id}.jsonl"

    if [[ -f "$jsonl_path" ]]; then
      local session_transcript
      # A2: -R + fromjson? skips malformed JSONL lines instead of aborting
      # A1+A5: head -c 200000 + iconv -c strips incomplete UTF-8 at boundary
      session_transcript=$(jq -R -r '
        fromjson? // empty |
        if .type == "user" and .message then
          .message.content |
          if type == "array" then
            [.[] | select(.type == "text") | .text // empty] | join("\n") |
            if . != "" then "--- human ---\n" + . else empty end
          elif type == "string" then
            if . != "" then "--- human ---\n" + . else empty end
          else empty end
        elif .type == "assistant" and .message then
          .message.content |
          if type == "array" then
            [.[] | select(.type == "text") | .text // empty] | join("\n") |
            if . != "" then "--- assistant ---\n" + . else empty end
          else empty end
        else empty end
      ' "$jsonl_path" 2>/dev/null | head -c 200000 | iconv -c -f utf-8 -t utf-8)

      if [[ -n "$session_transcript" ]]; then
        transcript_mode="jsonl"
        full_prompt="# Session transcript to analyze

Below is a text-only transcript of a completed Claude Code session.
Tool calls, tool results, and thinking blocks are omitted — focus on
decisions, discoveries, preferences, and patterns from the dialogue.

${session_transcript}

---

${prompt}"
      fi
    fi
  fi

  printf '\n🧠 ccRecall: extracting memories from session...\n'

  local extract_start
  extract_start=$(date +%s)

  if [[ "$transcript_mode" == "jsonl" ]]; then
    # Preferred: text-only transcript in prompt (works for any session size)
    command claude -p \
      --no-session-persistence \
      --model haiku \
      --max-budget-usd 0.10 \
      --max-turns 5 \
      --dangerously-skip-permissions \
      "$full_prompt" 2>/dev/null
  else
    # Fallback: continue last session (may fail for very long sessions)
    command claude -c -p \
      --no-session-persistence \
      --model haiku \
      --max-budget-usd 0.10 \
      --max-turns 5 \
      --dangerously-skip-permissions \
      "$prompt" 2>/dev/null
  fi

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
    --arg mode "$transcript_mode" \
    --argjson exit "$extract_exit" \
    --argjson dur "$extract_duration" \
    '{"ts":$ts,"sessionId":$sid,"projectId":$pid,"mode":$mode,"exitCode":$exit,"durationSec":$dur}' \
    >> "$CCRECALL_EXTRACT_LOG"

  return $claude_exit
}
