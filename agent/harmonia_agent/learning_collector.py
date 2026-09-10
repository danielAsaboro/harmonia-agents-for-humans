"""Durable scheduler collector. Host pins targets, windows, and one-shot cost reservations."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Callable
import httpx
from . import x_client
from .web_client import _client, get_connection, WebApiError


def collect_observation(collection: dict, *, fetch: Callable[[str], dict | None]) -> dict:
    result = {"collectionId": collection["id"], "token": collection["token"], "metrics": None, "outcome": "unavailable"}
    if not collection.get("costAuthorization") or not collection.get("postId"):
        result["reason"] = "missing_host_collection_authority"
    else:
        try:
            metrics = fetch(collection["postId"])
            if metrics is not None:
                metrics = {key: value for key, value in metrics.items() if value is not None}
            result.update(metrics=metrics, outcome="available" if metrics is not None else "unavailable")
            if metrics is None:
                result["reason"] = "official_provider_metrics_unavailable"
        except (httpx.TimeoutException, httpx.TransportError):
            result.update(outcome="unknown", reason="provider_response_unknown_requires_reconciliation")
        except x_client.XError as error:
            result.update(outcome="failed", reason=f"official_provider_rejected_metrics:{error.status}")
        except Exception as error:
            result.update(outcome="failed", reason=f"metrics_collection_failed:{type(error).__name__}")
    result["checkedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return result


def tick_learning() -> None:
    with _client() as client:
        response = client.get("/api/internal/learning/collections")
        if response.status_code != 200:
            raise WebApiError("learning collection claim failed", response.status_code)
        failures = []
        for collection in response.json()["collections"]:
            def fetch(post_id: str) -> dict | None:
                connection = get_connection("x")
                return x_client.get_post_metrics(post_id, connection.get("accessToken"))
            result = collect_observation(collection, fetch=fetch)
            # An ambiguous write is never followed by another provider call. The
            # durable lease becomes reconciliation_required on the next tick.
            try:
                response = client.post("/api/internal/learning/collections", json=result)
                if response.status_code != 200:
                    failures.append(response.status_code)
            except httpx.TransportError:
                failures.append(503)
        if failures:
            raise WebApiError("learning observation persistence requires reconciliation", failures[0])
