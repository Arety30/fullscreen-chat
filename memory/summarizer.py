from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


DEFAULT_OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
DEFAULT_MODEL = os.getenv("OLLAMA_SUMMARY_MODEL", "qwen2.5-coder:1.5b")


def summarize_terminal_output(
    output: str,
    *,
    ollama_base_url: str = DEFAULT_OLLAMA_BASE_URL,
    model: str = DEFAULT_MODEL,
    timeout: float = 30.0,
    max_input_chars: int = 12000,
) -> str:
    """Summarize bulky shell output into two concise sentences using local Ollama."""
    cleaned = output.strip()
    if not cleaned:
        return "No terminal output was produced. There is nothing to summarize."

    prompt = (
        "Summarize this terminal output or traceback in exactly two concise sentences. "
        "Mention the command outcome, root error if visible, and the most useful next diagnostic. "
        "Do not include markdown or code fences.\n\n"
        f"{cleaned[-max_input_chars:]}"
    )

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "num_ctx": 4096,
            "temperature": 0.1,
        },
    }

    try:
        request = urllib.request.Request(
            f"{ollama_base_url.rstrip('/')}/api/generate",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
        summary = str(body.get("response", "")).strip()
        if summary:
            return _force_two_sentences(summary)
    except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        pass

    return fallback_summary(cleaned)


def fallback_summary(output: str, max_chars: int = 700) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return "No terminal output was produced. There is nothing to summarize."

    error_line = next(
        (
            line
            for line in reversed(lines)
            if any(marker in line.lower() for marker in ("error", "exception", "traceback", "failed", "fatal"))
        ),
        lines[-1],
    )
    first_line = lines[0]
    combined = f"Terminal output began with: {first_line}. Most relevant ending signal: {error_line}."
    return _force_two_sentences(_truncate(combined, max_chars))


def _force_two_sentences(text: str) -> str:
    normalized = " ".join(text.split())
    sentences = [part.strip() for part in normalized.replace("!", ".").replace("?", ".").split(".") if part.strip()]
    if len(sentences) >= 2:
        return f"{sentences[0]}. {sentences[1]}."
    if len(sentences) == 1:
        return f"{sentences[0]}. No additional diagnostic detail was available."
    return "The output could not be summarized. Re-run the command with logging enabled for more detail."


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars].rstrip()}..."
