"""Durable scheduler collector. Host pins targets, windows, and one-shot cost reservations."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Callable
import httpx
from . import x_client
from .web_client import _client, get_connection, WebApiError

def _future(value: str | None) -> bool:
    return bool(value) and datetime.fromisoformat(value.replace("Z", "+00:00")) > datetime.now(timezone.utc)


def collect_observation(collection: dict, *, fetch: Callable[[str], dict | None]) -> dict:
    result = {"collectionId": collection["id"], "token": collection["token"], "metrics": None, "outcome": "unavailable"}
    permit = collection.get("dispatch") or {}
    if not _future(permit.get("expiresAt")) or not _future(collection.get("expiresAt")):
        result["reason"] = "expired_before_provider_dispatch"
    elif permit.get("token") != collection["token"] or not collection.get("costAuthorization") or not collection.get("postId"):
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
        failures = []
        for _ in range(20):
            response = client.get("/api/internal/learning/collections")
            if response.status_code != 200:
                raise WebApiError("learning collection claim failed", response.status_code)
            collections = response.json()["collections"]
            if not collections:
                break
            if len(collections) != 1:
                raise WebApiError("host must claim one collection near dispatch", 409)
            collection = collections[0]
            identity = {"collectionId": collection["id"], "token": collection["token"]}
            def cancel(reason: str) -> None:
                response = client.patch("/api/internal/learning/collections", json={**identity, "action": "cancel", "reason": reason})
                if response.status_code != 200:
                    failures.append(response.status_code)
            if not _future(collection.get("leaseUntil")) or not _future(collection.get("expiresAt")):
                cancel("expired_before_provider_dispatch")
                continue
            try:
                connection = get_connection("x")
            except (WebApiError, httpx.TransportError):
                cancel("missing_connection_before_dispatch")
                continue
            if not connection.get("accessToken"):
                cancel("missing_connection_before_dispatch")
                continue
            permit = client.patch("/api/internal/learning/collections", json={**identity, "action": "dispatch"})
            if permit.status_code != 200:
                failures.append(permit.status_code)
                continue
            collection = permit.json().get("collection")
            if not collection:
                continue
            result = collect_observation(collection, fetch=lambda post_id: x_client.get_post_metrics(post_id, connection["accessToken"]))
            if result.get("reason") in {"expired_before_provider_dispatch", "missing_host_collection_authority"}:
                cancel(result["reason"])
                continue
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
