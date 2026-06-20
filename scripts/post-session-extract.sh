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

# Resolve the directory containing this script (for prompt file).
# zsh leaves BASH_SOURCE empty (the user's shell is zsh), so detect zsh and
# use its %x prompt path; eval isolates the zsh-only ${(%):-%x} syntax from
# bash's parser. Without this, CCRECALL_SCRIPT_DIR fell back to $PWD under zsh
# and extraction-prompt.md was never read (silently using the inline fallback).
if [ -n "${ZSH_VERSION:-}" ]; then
  eval '_ccrecall_src="${(%):-%x}"'
else
  _ccrecall_src="${BASH_SOURCE[0]}"
fi
CCRECALL_SCRIPT_DIR="$(cd "$(dirname "$_ccrecall_src")" && pwd)"
unset _ccrecall_src

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
  local transcript_mode="none"
  local full_prompt=""
  local skip_reason="no-session-id"  # refined as the build gets further

  # A4: validate session_id is a UUID before using in filesystem path
  local claude_data_dir="${HOME}/.claude"
  if [[ -n "$session_id" && "$session_id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then
    skip_reason="no-jsonl"
    local jsonl_path="${claude_data_dir}/projects/${project_id}/${session_id}.jsonl"

    if [[ -f "$jsonl_path" ]]; then
      skip_reason="empty-transcript"
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

Origin session ID: ${session_id}
Pass this verbatim as the sessionId argument on every recall_save call so
each saved memory traces back to its origin session.

Below is a text-only transcript of a completed Claude Code session.
Tool calls, tool results, and thinking blocks are omitted — focus on
decisions, discoveries, preferences, and patterns from the dialogue.

${session_transcript}

---

${prompt}"
      fi
    fi
  fi

  # No text transcript built → skip extraction. We deliberately do NOT
  # fall back to `claude -c` (continue): that reloads the full session
  # (tool calls, results, thinking blocks) and burns subscription usage
  # for frequently-zero output (verified 2026-06-20: continue runs cost
  # more and usually saved nothing). A missed session is cheaper than that.
  if [[ "$transcript_mode" != "jsonl" ]]; then
    printf '\n⚠️  ccRecall: no text transcript (%s) — skipping extraction.\n' "$skip_reason"
    mkdir -p "$(dirname "$CCRECALL_EXTRACT_LOG")"
    jq -n -c \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg sid "$session_id" \
      --arg pid "$project_id" \
      --arg reason "$skip_reason" \
      '{ts:$ts,sessionId:$sid,projectId:$pid,mode:"skip",reason:$reason,exitCode:null,durationSec:0}' \
      >> "$CCRECALL_EXTRACT_LOG"
    return $claude_exit
  fi

  printf '\n🧠 ccRecall: extracting memories from session...\n'

  local extract_start
  extract_start=$(date +%s)

  # Spend cap only matters under API billing. With no ANTHROPIC_API_KEY,
  # `claude -p` runs on the Pro/Max subscription quota and --max-budget-usd
  # would gate on phantom API-equivalent cost — the root cause of the
  # "Exceeded USD budget (0.1)" failures. So cap only when a key is present;
  # --max-turns 5 + the head -c 200000 transcript cap bound turns/input either way.
  local -a budget_args=()
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    budget_args=(--max-budget-usd "${CCRECALL_EXTRACT_MAX_BUDGET_USD:-0.50}")
  fi

  # Capture stderr WITHOUT a temp file (no leak on interrupt/early exit):
  # fd 3 holds the real stdout so the agent's output still streams to the
  # terminal, while stderr is redirected into the command substitution.
  local extract_stderr extract_exit
  exec 3>&1
  extract_stderr=$(command claude -p \
    --no-session-persistence \
    --model haiku \
    "${budget_args[@]}" \
    --max-turns 5 \
    --dangerously-skip-permissions \
    "$full_prompt" 2>&1 1>&3)
  extract_exit=$?
  exec 3>&-
  extract_stderr=$(printf '%s' "$extract_stderr" | head -c 2000)

  local extract_end
  extract_end=$(date +%s)
  local extract_duration=$(( extract_end - extract_start ))

  if [[ $extract_exit -eq 0 ]]; then
    printf '✅ ccRecall: extraction complete (%ds).\n' "$extract_duration"
  else
    printf '⚠️  ccRecall: extraction exited with code %d (%ds).\n' "$extract_exit" "$extract_duration"
  fi

  # Telemetry log (-c = one compact JSON object per line = valid JSONL)
  mkdir -p "$(dirname "$CCRECALL_EXTRACT_LOG")"
  jq -n -c \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg sid "$session_id" \
    --arg pid "$project_id" \
    --arg stderr "$extract_stderr" \
    --argjson exit "$extract_exit" \
    --argjson dur "$extract_duration" \
    '{ts:$ts,sessionId:$sid,projectId:$pid,mode:"jsonl",exitCode:$exit,durationSec:$dur,stderr:$stderr}' \
    >> "$CCRECALL_EXTRACT_LOG"

  return $claude_exit
}
