"""Telegram operator surface (official Bot API, long polling only).

Scoped to a single allow-listed chat ID. Shares the dashboard's intent
grammar by delegating message understanding to the web service's
/api/chat endpoint; approval decisions are executed only through an
explicit inline-button callback, never from the parsed message text.
Bot tokens are never echoed into chat output.
"""

from __future__ import annotations

import logging
import hashlib
import threading
import time
from typing import Any

import httpx

from .web_client import WebApiError, chat, get_telegram_connection, get_workspaces
from .tenant_context import current_tenant, tenant_scope

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
    def __init__(
        self,
        bot_token: str,
        allowed_chat_id: str,
        workspace_id: str,
        brand_id: str,
        stop_event: threading.Event | None = None,
    ) -> None:
        self.bot_token = bot_token
        self.allowed_chat_id = allowed_chat_id
        self.workspace_id = workspace_id
        self.brand_id = brand_id
        self.stop_event = stop_event or threading.Event()
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
        # The worker may display pending work, but it never mints approval
        # callbacks. Only the web service can issue one-time webhook nonces.
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
        answer_text = "This legacy callback cannot authorize an action. Use a new server-issued confirmation."
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
        while not self.stop_event.is_set():
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
                    with tenant_scope(self.workspace_id, self.brand_id):
                        if "callback_query" in update:
                            self._handle_callback(update)
                        elif "message" in update:
                            self._handle_message(update)
                except Exception:  # noqa: BLE001 - keep the loop alive
                    logger.exception("update processing error")


def _supervise() -> None:
    started: dict[str, tuple[str, threading.Event]] = {}
    while True:
        try:
            for workspace in get_workspaces():
                workspace_id = workspace["workspaceId"]
                with tenant_scope(workspace_id, workspace["brandId"]):
                    connection = get_telegram_connection()
                current = started.get(workspace_id)
                if not connection:
                    if current:
                        current[1].set()
                        started.pop(workspace_id, None)
                    continue
                fingerprint = hashlib.sha256(
                    f"{connection['botToken']}:{connection['chatId']}".encode()
                ).hexdigest()
                if current and current[0] == fingerprint:
                    continue
                if current:
                    current[1].set()
                stop_event = threading.Event()
                bot = TelegramBot(
                    connection["botToken"], connection["chatId"],
                    workspace_id, workspace["brandId"], stop_event,
                )
                threading.Thread(target=bot.run_forever, daemon=True).start()
                started[workspace_id] = (fingerprint, stop_event)
        except Exception:  # noqa: BLE001 - supervisor must survive one workspace failure
            logger.exception("Telegram workspace discovery failed")
        time.sleep(60)


def start_background() -> None:
    """Entry point used by main.py at import time."""
    threading.Thread(target=_supervise, daemon=True).start()


def notify(text: str) -> bool:
    """One-way push of a proactive notification to the allow-listed chat.

    Returns True when delivered. Missing configuration is not an error —
    the Telegram surface is optional; callers log the skip instead.
    """
    connection = get_telegram_connection()
    if not connection:
        return False
    try:
        tenant = current_tenant()
        TelegramBot(
            connection["botToken"], connection["chatId"],
            tenant.workspace_id, tenant.brand_id,
        )._api(
            "sendMessage", {"chat_id": connection["chatId"], "text": text}
        )
        return True
    except Exception as exc:  # noqa: BLE001 - delivery must never crash proactive checks
        logger.warning("telegram notify failed: %s", exc)
        return False


def main() -> None:
    """Standalone entry point: `python -m harmonia_agent.telegram_bot`."""
    logging.basicConfig(level=logging.INFO)
    raise SystemExit("Telegram bots are managed per workspace by the worker supervisor")


if __name__ == "__main__":
    main()
