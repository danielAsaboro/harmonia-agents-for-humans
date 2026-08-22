"""GitHub REST integration: evidence probes plus idempotent corrective
actions (file upsert, issue creation). Every mutation is keyed by an
idempotency key derived from the action and desired content."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

import httpx

API = "https://api.github.com"


class GitHubError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status

    @property
    def permanent(self) -> bool:
        return self.status is not None and 400 <= self.status < 500 and self.status != 429


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _client(token: str | None) -> httpx.Client:
    if not token:
        raise GitHubError("GITHUB_TOKEN is not configured", 401)
    return httpx.Client(base_url=API, headers=_headers(token), timeout=30)


def get_repo(owner: str, repo: str) -> dict[str, Any]:
    with _client(_token()) as c:
        res = c.get(f"/repos/{owner}/{repo}")
    if res.status_code != 200:
        raise GitHubError(f"repo fetch failed: {res.status_code}", res.status_code)
    return res.json()


def list_tree(owner: str, repo: str, ref: str | None = None) -> list[dict[str, Any]]:
    info = get_repo(owner, repo)
    branch = ref or info["default_branch"]
    with _client(_token()) as c:
        res = c.get(f"/repos/{owner}/{repo}/git/trees/{branch}", params={"recursive": "1"})
    if res.status_code != 200:
        raise GitHubError(f"tree fetch failed: {res.status_code}", res.status_code)
    return res.json().get("tree", [])


def get_file(owner: str, repo: str, path: str, ref: str | None = None) -> dict[str, Any] | None:
    """Returns {sha, content, digest, html_url, url} or None when absent."""
    with _client(_token()) as c:
        params = {"ref": ref} if ref else None
        res = c.get(f"/repos/{owner}/{repo}/contents/{path}", params=params)
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        raise GitHubError(f"content fetch failed for {path}: {res.status_code}", res.status_code)
    data = res.json()
    if isinstance(data, list):
        return None
    raw = base64.b64decode(data.get("content", "")).decode("utf-8", errors="replace")
    return {
        "sha": data["sha"],
        "path": data["path"],
        "content": raw,
        "digest": hashlib.sha256(raw.encode()).hexdigest(),
        "html_url": data.get("html_url"),
        "url": f"{API}/repos/{owner}/{repo}/contents/{path}",
    }


def upsert_file_idempotent(
    owner: str,
    repo: str,
    path: str,
    branch: str,
    content: str,
    message: str,
    idempotency_key: str,
) -> dict[str, Any]:
    """Create or update a file. Returns outcome 'applied' or 'already_applied'."""
    marker = f"closefold-idem:{idempotency_key}"
    full_message = f"{message}\n\n{marker}"
    existing = get_file(owner, repo, path, ref=branch)
    desired_digest = hashlib.sha256(content.encode()).hexdigest()
    if existing and existing["digest"] == desired_digest:
        return {"outcome": "already_applied", "artifact_url": existing["url"], "blob_sha": existing["sha"]}
    body: dict[str, Any] = {
        "message": full_message,
        "content": base64.b64encode(content.encode()).decode(),
        "branch": branch,
    }
    if existing:
        body["sha"] = existing["sha"]
    with _client(_token()) as c:
        res = c.put(f"/repos/{owner}/{repo}/contents/{path}", json=body)
    if res.status_code not in (200, 201):
        raise GitHubError(f"upsert failed for {path}: {res.status_code} {res.text}", res.status_code)
    commit = res.json()["commit"]
    return {
        "outcome": "applied",
        "artifact_url": res.json()["content"]["url"],
        "blob_sha": res.json()["content"]["sha"],
        "commit_sha": commit["sha"],
    }


def create_issue_idempotent(
    owner: str,
    repo: str,
    title: str,
    body: str,
    labels: list[str],
    idempotency_key: str,
) -> dict[str, Any]:
    marker = f"closefold-idem:{idempotency_key}"
    with _client(_token()) as c:
        search = c.get(
            "/search/issues",
            params={"q": f"repo:{owner}/{repo} \"{marker}\" in:body type:issue"},
        )
        if search.status_code == 200:
            items = search.json().get("items", [])
            if items:
                issue = items[0]
                return {"outcome": "already_applied", "artifact_url": issue["html_url"], "issue_number": issue["number"]}
        elif search.status_code == 403:
            # Search API rate limits; fall through to unauthenticated dedupe below.
            pass
        else:
            raise GitHubError(f"issue search failed: {search.status_code}", search.status_code)

        listed = c.get(f"/repos/{owner}/{repo}/issues", params={"state": "open", "per_page": 100})
        if listed.status_code == 200:
            for issue in listed.json():
                if marker in (issue.get("body") or ""):
                    return {"outcome": "already_applied", "artifact_url": issue["html_url"], "issue_number": issue["number"]}

        res = c.post(
            f"/repos/{owner}/{repo}/issues",
            json={"title": title, "body": f"{body}\n\n{marker}", "labels": labels},
        )
    if res.status_code != 201:
        raise GitHubError(f"issue creation failed: {res.status_code} {res.text}", res.status_code)
    issue = res.json()
    return {"outcome": "applied", "artifact_url": issue["html_url"], "issue_number": issue["number"]}


def get_issue(owner: str, repo: str, number: int) -> dict[str, Any] | None:
    with _client(_token()) as c:
        res = c.get(f"/repos/{owner}/{repo}/issues/{number}")
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        raise GitHubError(f"issue fetch failed: {res.status_code}", res.status_code)
    return res.json()


def _token() -> str:
    from .config import settings

    token = settings().github_token
    if not token:
        raise GitHubError("GITHUB_TOKEN is not configured", 401)
    return token


def action_idempotency_key(job_id: str, action_id: str, payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    material = f"{job_id}|{action_id}|{canonical}"
    return hashlib.sha256(material.encode()).hexdigest()
