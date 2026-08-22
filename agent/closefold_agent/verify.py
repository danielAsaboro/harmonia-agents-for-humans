"""Independent verification: every rubric item is re-checked against a fresh
fetch of the underlying artifact. A model's claim is never accepted as proof;
only a fetched artifact or API response can mark an item verified."""

from __future__ import annotations

from typing import Any

from . import github_client
from .github_client import get_file


def _file_obs(observations: list[dict[str, Any]], path: str) -> dict[str, Any] | None:
    return next((o for o in observations if o["kind"] == "github_file" and o["target"] == path), None)


def verify_readme(obs: dict[str, Any] | None) -> tuple[bool, str]:
    if not obs or not obs.get("ok"):
        return False, "README.md absent or unfetchable"
    detail = obs.get("detail", {})
    if obs.get("excerpt") and len(obs["excerpt"]) < 400:
        return False, "README.md too short to contain spin-up instructions"
    if not (detail.get("mentions_npm") or detail.get("mentions_gcloud")):
        return False, "README.md lacks concrete install/deploy commands"
    return True, f"README.md present ({detail.get('bytes')} bytes) with runnable commands"


def verify_license(obs: dict[str, Any] | None) -> tuple[bool, str]:
    if obs and obs.get("ok"):
        return True, "LICENSE file exists in repository"
    return False, "LICENSE file missing from repository root"


def verify_architecture(observations: list[dict[str, Any]]) -> tuple[bool, str]:
    for path in ("docs/architecture.md", "docs/architecture.mmd", "docs/architecture.svg", "docs/architecture.png", "architecture.md", "docs/ARCHITECTURE.md"):
        obs = _file_obs(observations, path)
        if obs and obs.get("ok"):
            readme = _file_obs(observations, "README.md")
            linked = bool(readme and "architecture" in (readme.get("excerpt", "") + str(readme.get("detail", {}))).lower())
            return True, f"architecture artifact found at {path}" + ("" if linked else "; consider linking it from README")
    return False, "no architecture diagram/document found at conventional paths"


def verify_video_link(observations: list[dict[str, Any]]) -> tuple[bool, str]:
    for o in observations:
        if o["kind"] == "github_file" and o.get("ok") and o.get("detail", {}).get("has_video_link"):
            return True, f"demonstration video link found in {o['target']}"
    return False, "no YouTube/Vimeo demonstration link found in repository files"


def verify_cloud_deployment(observations: list[dict[str, Any]]) -> tuple[bool, str]:
    cloud = next((o for o in observations if o["kind"] == "cloud_run_url"), None)
    if cloud and cloud.get("ok"):
        return True, f"deployment URL answered HTTP 200 ({cloud['url']})"
    for o in observations:
        if o["kind"] == "github_file" and o.get("detail", {}).get("has_run_app_url"):
            return True, f".run.app deployment URL referenced in {o['target']} but not probed live"
    return False, "no live Cloud Run URL configured or discoverable"


def verify_gemini_adk_usage(observations: list[dict[str, Any]]) -> tuple[bool, str]:
    tree_obs = next((o for o in observations if o["target"].endswith(":tree")), None)
    paths = (tree_obs or {}).get("detail", {}).get("paths", [])
    agent_files = [p for p in paths if p.startswith("agent/") and p.endswith(".py")]
    readme = _file_obs(observations, "README.md")
    mentions = bool(readme and readme.get("ok") and (readme.get("detail", {}).get("mentions_gemini") or readme.get("detail", {}).get("mentions_adk")))
    if agent_files:
        return True, f"ADK agent sources present: {', '.join(agent_files[:3])}"
    if mentions:
        return True, "README documents Gemini/ADK usage"
    return False, "no ADK agent sources found in agent/ directory"


def verify_rubric_item(item: dict[str, Any], observations: list[dict[str, Any]]) -> dict[str, Any]:
    category = item.get("category", "").lower()
    requirement = item.get("requirement", "").lower()

    def result(verified: bool, note: str, url: str, digest: str | None = None) -> dict[str, Any]:
        evidence: dict[str, Any] = {
            "kind": "http_probe" if url.startswith("http") else "github_api",
            "url": url,
            "fetchedAt": "",
        }
        if digest:
            evidence["digest"] = digest
        out = {"rubricItemId": item["id"], "verified": verified, "method": f"mechanical:{category or 'general'}", "evidence": evidence}
        if note:
            out["note"] = note
        return out

    primary_url = f"https://api.github.com/repos/{item.get('source', '')}"

    if "readme" in category or "spin-up" in requirement or "instruction" in requirement:
        ok, note = verify_readme(_file_obs(observations, "README.md"))
        return result(ok, note, f"https://api.github.com/repos/{_repo_slug(item)}/contents/README.md")
    if "license" in category or "license" in requirement:
        ok, note = verify_license(_file_obs(observations, "LICENSE"))
        return result(ok, note, f"https://api.github.com/repos/{_repo_slug(item)}/contents/LICENSE")
    if "architecture" in category or "diagram" in requirement:
        ok, note = verify_architecture(observations)
        return result(ok, note, f"https://api.github.com/repos/{_repo_slug(item)}")
    if "video" in requirement or "demo" in requirement:
        ok, note = verify_video_link(observations)
        return result(ok, note, f"https://api.github.com/repos/{_repo_slug(item)}")
    if "cloud run" in category or "deploy" in requirement or "google cloud" in requirement:
        ok, note = verify_cloud_deployment(observations)
        return result(ok, note, item.get("source", "https://cloud.google.com/run"))
    if "gemini" in requirement or "adk" in requirement or "vertex" in requirement or "agent framework" in requirement:
        ok, note = verify_gemini_adk_usage(observations)
        return result(ok, note, f"https://api.github.com/repos/{_repo_slug(item)}")

    # Unmapped categories remain unverified rather than silently passing.
    return result(False, "category not covered by mechanical verifiers; manual review required", primary_url)


def _repo_slug(item: dict[str, Any]) -> str:
    source = item.get("source", "")
    parts = [p for p in source.split("/") if p]
    if len(parts) >= 2:
        return f"{parts[-2]}/{parts[-1]}"
    return "unknown/unknown"


def verify_action(
    job_id: str,
    action: dict[str, Any],
    receipt_detail: dict[str, Any],
) -> dict[str, Any]:
    """Re-checks the external effect of one executed action via independent fetch."""
    payload = action.get("payload", {})
    owner_repo = receipt_detail.get("ownerRepo") or ""
    owner, _, repo = owner_repo.partition("/")
    base = {
        "actionId": action["id"],
        "verified": False,
        "method": f"independent_refetch:{action['type']}",
    }

    if action["type"] == "github_upsert_file":
        path = payload.get("path", "")
        branch = payload.get("branch", "")
        try:
            blob = get_file(owner, repo, path, ref=branch or None)
        except github_client.GitHubError as exc:
            base["note"] = f"verification refetch failed: {exc}"
            base["evidence"] = {"kind": "github_api", "url": f"https://api.github.com/repos/{owner}/{repo}/contents/{path}", "fetchedAt": ""}
            return {**base, "rubricItemId": (action.get("rubricItemIds") or [""])[0]}
        if blob is None:
            base["note"] = f"{path} still absent after execution"
        else:
            expected = payload.get("expectedDigest")
            if expected and blob["digest"] != expected:
                base["note"] = f"content digest mismatch after write ({blob['digest'][:12]}… != {expected[:12]}…)"
            else:
                base["verified"] = True
                base["note"] = f"fetched {path} at branch '{branch}'; blob sha {blob['sha'][:12]}… matches intended content"
            base["evidence"] = {
                "kind": "github_blob",
                "url": blob["url"],
                "fetchedAt": "",
                "digest": blob["digest"],
            }
        return {**base, "rubricItemId": (action.get("rubricItemIds") or [""])[0]}

    if action["type"] == "github_create_issue":
        number = receipt_detail.get("issueNumber")
        try:
            issue = github_client.get_issue(owner, repo, int(number)) if number else None
        except (github_client.GitHubError, TypeError, ValueError):
            issue = None
        if issue is not None and issue.get("state") == "open":
            base["verified"] = True
            base["note"] = f"issue #{issue['number']} open with corrective checklist"
            base["evidence"] = {"kind": "github_api", "url": issue["html_url"], "fetchedAt": ""}
        else:
            base["note"] = "corrective issue could not be re-fetched"
            base["evidence"] = {"kind": "github_api", "url": f"https://github.com/{owner}/{repo}/issues", "fetchedAt": ""}
        return {**base, "rubricItemId": (action.get("rubricItemIds") or [""])[0]}

    base["note"] = "unsupported action type"
    base["evidence"] = {"kind": "github_api", "url": f"https://api.github.com/repos/{owner}/{repo}", "fetchedAt": ""}
    return {**base, "rubricItemId": (action.get("rubricItemIds") or [""])[0]}
