from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_CONTEXT_TOKEN_LIMIT = 4000
DEFAULT_STORAGE_DIR = Path(os.getenv("MEMORY_STATE_DIR", "memory/state"))


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def estimate_tokens(value: Any) -> int:
    """Cheap local token estimate suitable for guarding a 4096-token model."""
    if value is None:
        return 0
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True)
    words = value.split()
    char_estimate = max(1, len(value) // 4)
    return max(len(words), char_estimate)


def _safe_session_id(session_id: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "_" for ch in session_id)
    cleaned = cleaned.strip("._")
    if not cleaned:
        raise ValueError("session_id must contain at least one safe character")
    return cleaned[:128]


def _compact_entry(entry: dict[str, Any], max_chars: int = 280) -> dict[str, Any]:
    role = str(entry.get("role", "unknown"))
    content = str(entry.get("content", ""))
    content = " ".join(content.split())
    if len(content) > max_chars:
        content = f"{content[:max_chars].rstrip()}..."
    return {
        "role": "summary",
        "content": f"Condensed prior {role} entry: {content}",
        "created_at": entry.get("created_at", utc_now_iso()),
        "metadata": {
            "source_role": role,
            "condensed": True,
        },
    }


@dataclass(slots=True)
class StateManager:
    storage_dir: Path | str = DEFAULT_STORAGE_DIR
    context_token_limit: int = DEFAULT_CONTEXT_TOKEN_LIMIT
    reserve_tokens: int = 96

    def __post_init__(self) -> None:
        self.storage_dir = Path(self.storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        if self.context_token_limit <= 0:
            raise ValueError("context_token_limit must be positive")
        if self.reserve_tokens < 0:
            raise ValueError("reserve_tokens cannot be negative")

    def session_path(self, session_id: str) -> Path:
        return self.storage_dir / f"{_safe_session_id(session_id)}.json"

    def load_state(self, session_id: str) -> dict[str, Any]:
        path = self.session_path(session_id)
        if not path.exists():
            return self._empty_state(session_id)

        with path.open("r", encoding="utf-8") as handle:
            state = json.load(handle)

        state.setdefault("session_id", session_id)
        state.setdefault("history", [])
        state.setdefault("summaries", [])
        state.setdefault("created_at", utc_now_iso())
        state["updated_at"] = utc_now_iso()
        return state

    def save_state(self, session_id: str, state: dict[str, Any]) -> dict[str, Any]:
        state["session_id"] = session_id
        state["updated_at"] = utc_now_iso()
        state.setdefault("history", [])
        state.setdefault("summaries", [])
        trimmed = self.trim_context(state)
        self._atomic_write(self.session_path(session_id), trimmed)
        return trimmed

    def append_event(
        self,
        session_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        summarize_if_large: bool = False,
        large_output_threshold: int = 2400,
    ) -> dict[str, Any]:
        if not role:
            raise ValueError("role is required")

        if summarize_if_large and estimate_tokens(content) >= large_output_threshold:
            try:
                from memory.summarizer import summarize_terminal_output

                content = summarize_terminal_output(content)
                metadata = {**(metadata or {}), "auto_summarized": True}
            except Exception as exc:
                metadata = {**(metadata or {}), "auto_summarize_error": str(exc)}

        state = self.load_state(session_id)
        state["history"].append(
            {
                "role": role,
                "content": content,
                "created_at": utc_now_iso(),
                "metadata": metadata or {},
            }
        )
        return self.save_state(session_id, state)

    def get_context(self, session_id: str) -> list[dict[str, Any]]:
        state = self.load_state(session_id)
        return list(state.get("summaries", [])) + list(state.get("history", []))

    def token_count(self, state_or_context: dict[str, Any] | list[dict[str, Any]]) -> int:
        if isinstance(state_or_context, dict):
            context = list(state_or_context.get("summaries", [])) + list(state_or_context.get("history", []))
        else:
            context = state_or_context
        return sum(estimate_tokens(item) for item in context)

    def trim_context(self, state: dict[str, Any]) -> dict[str, Any]:
        hard_limit = max(1, self.context_token_limit - self.reserve_tokens)
        state.setdefault("history", [])
        state.setdefault("summaries", [])

        while self.token_count(state) > hard_limit and state["history"]:
            oldest = state["history"].pop(0)
            state["summaries"].append(_compact_entry(oldest))

            while self.token_count(state) > hard_limit and len(state["summaries"]) > 1:
                first = state["summaries"].pop(0)
                second = state["summaries"].pop(0)
                merged = {
                    "role": "summary",
                    "content": _merge_summary_text(first, second),
                    "created_at": first.get("created_at", utc_now_iso()),
                    "metadata": {"condensed": True, "merged": True},
                }
                state["summaries"].insert(0, merged)

            if self.token_count(state) > hard_limit and state["summaries"]:
                state["summaries"][0]["content"] = _truncate_text(
                    str(state["summaries"][0].get("content", "")),
                    max_chars=max(160, hard_limit * 3),
                )

        while self.token_count(state) > hard_limit and state["history"]:
            newest = state["history"][-1]
            newest["content"] = _truncate_text(str(newest.get("content", "")), max_chars=hard_limit * 3)
            break

        state["estimated_tokens"] = self.token_count(state)
        state["context_token_limit"] = self.context_token_limit
        return state

    def _empty_state(self, session_id: str) -> dict[str, Any]:
        now = utc_now_iso()
        return {
            "session_id": session_id,
            "created_at": now,
            "updated_at": now,
            "context_token_limit": self.context_token_limit,
            "estimated_tokens": 0,
            "summaries": [],
            "history": [],
        }

    @staticmethod
    def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, ensure_ascii=False, sort_keys=True)
                handle.write("\n")
            os.replace(tmp_name, path)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)


def _merge_summary_text(first: dict[str, Any], second: dict[str, Any]) -> str:
    text = f"{first.get('content', '')} {second.get('content', '')}"
    return _truncate_text(" ".join(str(text).split()), max_chars=500)


def _truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars].rstrip()}..."


default_state_manager = StateManager()
