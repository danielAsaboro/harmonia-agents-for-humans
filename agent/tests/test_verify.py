from closefold_agent.verify import verify_action, verify_rubric_item


def _obs_file(path: str, ok: bool = True, **detail):
    return {
        "kind": "github_file",
        "target": path,
        "url": f"https://api.github.com/repos/o/r/contents/{path}",
        "ok": ok,
        "digest": "a" * 64,
        "excerpt": "x" * 2000 if path == "README.md" else "",
        "detail": detail,
    }


def test_readme_requirement_verified_when_commands_present():
    obs = [_obs_file("README.md", mentions_npm=True, bytes=1200)]
    item = {"id": "setup", "category": "readme-setup", "requirement": "step-by-step spin-up instructions", "source": "https://example.com/o/r"}
    result = verify_rubric_item(item, obs)
    assert result["verified"] is True
    assert result["evidence"]["url"].endswith("/contents/README.md")


def test_license_missing_stays_unverified():
    item = {"id": "lic", "category": "license", "requirement": "include a license", "source": "https://example.com/o/r"}
    result = verify_rubric_item(item, [])
    assert result["verified"] is False


def test_unknown_category_never_silently_passes():
    item = {"id": "odd", "category": "mystery", "requirement": "something unusual", "source": "https://example.com/o/r"}
    result = verify_rubric_item(item, [])
    assert result["verified"] is False
    assert "not covered" in result["note"]


def test_cloud_deployment_verified_by_live_probe():
    obs = [
        {
            "kind": "cloud_run_url",
            "target": "https://svc.run.app",
            "url": "https://svc.run.app",
            "ok": True,
            "httpStatus": 200,
            "detail": {},
        }
    ]
    item = {"id": "deploy", "category": "cloud-deployment", "requirement": "deployed on Google Cloud Run", "source": ""}
    assert verify_rubric_item(item, obs)["verified"] is True


def test_verify_upsert_file_digest_match():
    action = {
        "id": "a1",
        "type": "github_upsert_file",
        "rubricItemIds": ["arch"],
        "payload": {"type": "github_upsert_file", "path": "docs/closefold-evidence.md", "branch": "main", "content": "hello"},
    }
    receipt_detail = {"ownerRepo": "octocat/hello"}

    class FakeGet:
        def __call__(self, owner, repo, path, ref=None):
            assert (owner, repo, path) == ("octocat", "hello", "docs/closefold-evidence.md")
            return {
                "sha": "abc123",
                "path": path,
                "content": "hello",
                "digest": __import__("hashlib").sha256(b"hello").hexdigest(),
                "html_url": "https://github.com/octocat/hello/blob/main/docs/closefold-evidence.md",
                "url": f"https://api.github.com/repos/octocat/hello/contents/{path}",
            }

    import closefold_agent.verify as v

    original = v.get_file
    v.get_file = FakeGet()
    try:
        result = verify_action("job1", action, receipt_detail)
    finally:
        v.get_file = original
    assert result["verified"] is True
    assert result["rubricItemId"] == "arch"
