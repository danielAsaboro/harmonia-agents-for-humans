"""Telegram operator surface (official Bot API, long polling only).

Scoped to a single allow-listed chat ID. Shares the dashboard's intent
grammar by delegating message understanding to the web service's
/api/chat endpoint; approval decisions are executed only through an
explicit inline-button callback, never from the parsed message text.
Bot tokens are never echoed into chat output.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

import httpx

from .config import settings
from .web_client import WebApiError, chat, decide

logger = logging.getLogger("harmonia.telegram")

TELEGRAM_API = "https://api.telegram.org"


def parse_callback_data(data: str) -> tuple[str, str, str] | None:
    """Returns (jobId, actionId, decision) for valid decision callbacks.

    Format: decide:{jobId}:{actionId}:{decision}
    """
    prefix, sep, remainder = data.partition(":")
    if prefix != "decide" or not sep:
        return None
    middle, sep_decision, decision = remainder.rpartition(":")
    if not sep_decision or decision not in ("approved", "rejected"):
        return None
    job_id, sep_action, action_id = middle.partition(":")
    if not sep_action or not job_id or not action_id or ":" in action_id:
        return None
    return job_id, action_id, decision


def is_chat_allowed(chat_id: int | str | None, allowed: str) -> bool:
    if chat_id is None:
        return False
    return str(chat_id).strip() == allowed.strip()


class TelegramBot:
    def __init__(self, bot_token: str, allowed_chat_id: str) -> None:
        self.bot_token = bot_token
        self.allowed_chat_id = allowed_chat_id
        self._offset = 0

    def _api(self, method: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        res = httpx.post(
            f"{TELEGRAM_API}/bot{self.bot_token}/{method}",
            json=payload or {},
            timeout=40,
        )
        body = res.json()
        if not body.get("ok"):
            raise RuntimeError(f"telegram {method} failed: {body.get('description')}")
        return body["result"]

    def _render_reply(self, payload: dict[str, Any]) -> tuple[str, list[list[dict[str, str]]]]:
        text = str(payload.get("reply", "…"))
        buttons: list[list[dict[str, str]]] = []
        pending = payload.get("pendingActions") or []
        job_id = payload.get("jobId")
        if pending and job_id:
            rows = []
            for action in pending:
                aid = action["id"]
                label = action.get("title", aid)[:60]
                rows.append([
                    {"text": f"✅ Approve: {label}", "callback_data": f"decide:{job_id}:{aid}:approved"},
                    {"text": "✗ Reject", "callback_data": f"decide:{job_id}:{aid}:rejected"},
                ])
            buttons = rows
        drafts = payload.get("drafts") or []
        for draft in drafts:
            text += f"\n\n— {draft.get('platform', 'x')}:\n{draft.get('text', '')}"
        jobs = payload.get("jobs") or []
        for job in jobs:
            text += f"\n• {job['id']} — {job.get('stage', '?')} ({job.get('status', '?')})"
        return text, buttons

    def _handle_message(self, update: dict[str, Any]) -> None:
        message = update.get("message") or {}
        chat_info = message.get("chat") or {}
        if not is_chat_allowed(chat_info.get("id"), self.allowed_chat_id):
            logger.warning("ignored message from disallowed chat")
            return
        text = (message.get("text") or "").strip()
        if not text:
            return
        try:
            payload = chat(text)
            reply, buttons = self._render_reply(payload)
            self._api(
                "sendMessage",
                {"chat_id": chat_info["id"], "text": reply, **({"reply_markup": {"inline_keyboard": buttons}} if buttons else {})},
            )
        except WebApiError as exc:
            logger.error("chat handling failed: %s", exc)
            self._api("sendMessage", {"chat_id": chat_info["id"], "text": f"Error: command failed ({exc.status}). Check worker logs."})
        except Exception:
            logger.exception("chat handling error")
            self._api("sendMessage", {"chat_id": chat_info["id"], "text": "Error: unexpected failure. Check worker logs."})

    def _handle_callback(self, update: dict[str, Any]) -> None:
        query = update.get("callback_query") or {}
        chat_info = (query.get("message") or {}).get("chat") or {}
        callback_id = query.get("id")
        parsed = parse_callback_data(query.get("data") or "")
        if not is_chat_allowed(chat_info.get("id"), self.allowed_chat_id):
            logger.warning("ignored callback from disallowed chat")
            if callback_id:
                self._api("answerCallbackQuery", {"callback_query_id": callback_id, "text": "Not allowed"})
            return
        if not parsed:
            if callback_id:
                self._api("answerCallbackQuery", {"callback_query_id": callback_id, "text": "Unrecognized button"})
            return
        job_id, action_id, decision_str = parsed
        try:
            result = decide(job_id, action_id, decision_str)
            note = result.get("note") or (
                f"publishing dispatched ({result['triggered']})" if result.get("triggered") else ""
            )
            answer_text = f"{decision_str.capitalize()} recorded." + (f" {note}." if note else "")
        except WebApiError as exc:
            logger.error("decision failed: %s", exc)
            answer_text = f"Decision failed ({exc.status}); check worker logs."
        if callback_id:
            self._api("answerCallbackQuery", {"callback_query_id": callback_id, "text": answer_text})
        message_id = (query.get("message") or {}).get("message_id")
        if message_id:
            try:
                self._api(
                    "editMessageReplyMarkup",
                    {"chat_id": chat_info.get("id"), "message_id": message_id, "reply_markup": {"inline_keyboard": []}},
                )
            except Exception:  # noqa: BLE001 - keyboard may already be gone
                pass
        self._api("sendMessage", {"chat_id": chat_info.get("id"), "text": answer_text})

    def run_forever(self) -> None:
        logger.info("telegram bot started (allow-listed chat %s)", self.allowed_chat_id)
        while True:
            try:
                updates = self._api(
                    "getUpdates",
                    {
                        "offset": self._offset,
                        "timeout": 25,
                        "allowed_updates": ["message", "callback_query"],
                    },
                )
                # Long poll returns after timeout; httpx timeout must exceed it.
            except httpx.HTTPError as exc:
                logger.warning("telegram poll transport error: %s", exc)
                time.sleep(5)
                continue
            except RuntimeError as exc:
                logger.error("telegram api error: %s", exc)
                time.sleep(5)
                continue
            for update in updates:
                self._offset = max(self._offset, int(update.get("update_id", 0)) + 1)
                try:
                    if "callback_query" in update:
                        self._handle_callback(update)
                    elif "message" in update:
                        self._handle_message(update)
                except Exception:  # noqa: BLE001 - keep the loop alive
                    logger.exception("update processing error")


def _start_if_configured() -> None:
    cfg = settings()
    if cfg.telegram_bot_token and cfg.telegram_allowed_chat_id:
        bot = TelegramBot(cfg.telegram_bot_token, cfg.telegram_allowed_chat_id)
        threading.Thread(target=bot.run_forever, daemon=True).start()
    elif cfg.telegram_bot_token or cfg.telegram_allowed_chat_id:
        raise RuntimeError(
            "TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_ID must be set together"
        )


def start_background() -> None:
    """Entry point used by main.py at import time."""
    _start_if_configured()


def main() -> None:
    """Standalone entry point: `python -m harmonia_agent.telegram_bot`."""
    logging.basicConfig(level=logging.INFO)
    cfg = settings()
    if not cfg.telegram_bot_token or not cfg.telegram_allowed_chat_id:
        raise SystemExit("TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_ID are required")
    TelegramBot(cfg.telegram_bot_token, cfg.telegram_allowed_chat_id).run_forever()


if __name__ == "__main__":
    main()
