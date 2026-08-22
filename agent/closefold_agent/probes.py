"""Deterministic evidence probes against authorized sources. Observations are
raw fetched facts (URL, status, digest, excerpt) that the evaluation stage
maps onto rubric items and the verification stage re-checks mechanically."""

from __future__ import annotations

import hashlib
import re
from typing import Any

import httpx

from .devpost import USER_AGENT
from .github_client import get_file, list_tree

ARCHITECTURE_PATHS = [
    "docs/architecture.md",
    "docs/architecture.mmd",
    "docs/architecture.svg",
    "docs/architecture.png",
    "architecture.md",
    "docs/ARCHITECTURE.md",
]

VIDEO_PATTERN = re.compile(r"https?://(?:www\.)?(youtube\.com|youtu\.be|vimeo\.com)/[\w/?=.-]+", re.IGNORECASE)
RUN_URL_PATTERN = re.compile(r"https?://[\w.-]+\.run\.app[\w/?.-]*", re.IGNORECASE)
SECRET_PATTERNS = [
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"ghp_[A-Za-z0-9]{30,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"AIza[A-Za-z0-9_-]{30,}"),
]


def _observation(
    kind: str,
    target: str,
    url: str,
    ok: bool,
    http_status: int | None = None,
    digest: str | None = None,
    excerpt: str | None = None,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "target": target,
        "url": url,
        "ok": ok,
        "httpStatus": http_status,
        "digest": digest,
        "excerpt": (excerpt or "")[:4000],
        "detail": detail or {},
    }


def probe_devpost(devpost_url: str) -> dict[str, Any]:
    with httpx.Client(follow_redirects=True, timeout=30) as client:
        res = client.get(devpost_url, headers={"User-Agent": USER_AGENT})
    body_digest = hashlib.sha256(res.content).hexdigest()
    return _observation(
        "devpost_source",
        devpost_url,
        devpost_url,
        res.status_code == 200,
        res.status_code,
        body_digest,
        res.text[:2000],
        {"bytes": len(res.content)},
    )


def probe_github_repo(owner: str, repo: str) -> tuple[dict[str, Any], str, list[dict[str, Any]]]:
    """Returns (repo observation, default_branch, file tree)."""
    from .github_client import get_repo

    info = get_repo(owner, repo)
    branch = info["default_branch"]
    obs = _observation(
        "github_repo",
        f"{owner}/{repo}",
        info["html_url"],
        True,
        200,
        None,
        json_excerpt(info),
        {"default_branch": branch, "private": info.get("private", False), "visibility": info.get("visibility")},
    )
    return obs, branch, list_tree(owner, repo, branch)


def json_excerpt(data: dict[str, Any]) -> str:
    import json as _json

    return _json.dumps({k: data.get(k) for k in ("full_name", "default_branch", "description", "license")})[:1000]


def probe_github_files(owner: str, repo: str, tree: list[dict[str, Any]], max_files: int = 12) -> list[dict[str, Any]]:
    paths = [entry["path"] for entry in tree if entry.get("type") == "blob"]
    interesting: set[str] = set()
    for p in paths:
        if p in ARCHITECTURE_PATHS or p == "README.md" or p == "LICENSE" or p.startswith(".github/workflows/"):
            interesting.add(p)
    observations: list[dict[str, Any]] = []
    for path in sorted(interesting)[:max_files]:
        blob = get_file(owner, repo, path)
        if blob is None:
            continue
        findings_detail: dict[str, Any] = {}
        text = blob["content"]
        findings_detail["has_video_link"] = bool(VIDEO_PATTERN.search(text))
        findings_detail["has_run_app_url"] = bool(RUN_URL_PATTERN.search(text))
        findings_detail["secret_hits"] = [p.pattern for p in SECRET_PATTERNS if p.search(text)]
        findings_detail["bytes"] = len(text)
        if path == "README.md":
            findings_detail["mentions_npm"] = "npm install" in text or "npm run" in text
            findings_detail["mentions_gcloud"] = "gcloud" in text
            findings_detail["mentions_adk"] = "adk" in text.lower() or "google-adk" in text.lower()
            findings_detail["mentions_gemini"] = "gemini" in text.lower()
        observations.append(
            _observation(
                "github_file",
                path,
                blob["url"],
                True,
                200,
                blob["digest"],
                text[:1500],
                findings_detail,
            )
        )
    missing_architecture = [p for p in ("README.md", "LICENSE") + tuple(ARCHITECTURE_PATHS[:2]) if p not in interesting and not any(o["target"] == p for o in observations)]
    for path in missing_architecture:
        observations.append(
            _observation(
                "github_file",
                path,
                f"https://github.com/{owner}/{repo}/blob/HEAD/{path}",
                False,
                404,
                None,
                "",
                {"absent": True},
            )
        )
    return observations


def probe_cloud_run(url: str) -> dict[str, Any]:
    try:
        with httpx.Client(follow_redirects=True, timeout=20) as client:
            res = client.get(url, headers={"User-Agent": USER_AGENT})
        return _observation(
            "cloud_run_url",
            url,
            url,
            res.status_code == 200,
            res.status_code,
            hashlib.sha256(res.content).hexdigest(),
            res.text[:500],
            {"server": res.headers.get("server")},
        )
    except httpx.HTTPError as exc:
        return _observation("cloud_run_url", url, url, False, None, None, "", {"error": str(exc)})


def run_all_observations(config: dict[str, Any]) -> list[dict[str, Any]]:
    owner = config["githubOwner"]
    repo = config["githubRepo"]
    observations: list[dict[str, Any]] = []
    observations.append(probe_devpost(config["devpostUrl"]))
    repo_obs, branch, tree = probe_github_repo(owner, repo)
    observations.append(repo_obs)
    observations.extend(probe_github_files(owner, repo, tree))
    observations.append(_observation("github_repo", f"{owner}/{repo}:tree", f"https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}", True, 200, None, "", {"paths": [e["path"] for e in tree if e.get('type') == 'blob'][:200]}))
    cloud_url = config.get("cloudRunUrl")
    if cloud_url:
        observations.append(probe_cloud_run(cloud_url))
    return observations
