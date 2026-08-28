import json

import pytest

from harmonia_agent.artifact_export import render_json, render_markdown
from harmonia_agent.content_artifacts import ContentArtifactDraft


@pytest.mark.parametrize(
    ("artifact", "expected_fragment"),
    [
        ({"id": "a1", "outputPlanItemId": "o1", "outputType": "x_post", "title": "Post", "sourceSegmentRefs": ["s:1"], "payload": {"kind": "x_post", "text": "Proof, not promises."}}, "Proof, not promises."),
        ({"id": "a2", "outputPlanItemId": "o2", "outputType": "linkedin_post", "title": "LinkedIn", "sourceSegmentRefs": ["s:1"], "payload": {"kind": "linkedin_post", "body": "Operational proof", "title": "Launch", "cta": "Read more"}}, "Operational proof"),
        ({"id": "a3", "outputPlanItemId": "o3", "outputType": "newsletter", "title": "Letter", "sourceSegmentRefs": ["s:1"], "payload": {"kind": "newsletter", "subject": "Launch", "preheader": "Evidence", "introduction": "Hello", "sections": [{"id": "sec-1", "heading": "Proof", "body": "Nine days became forty hours.", "sourceSegmentRefs": ["s:1"]}], "cta": "Try it"}}, "## Proof"),
    ],
)
def test_renderers_are_deterministic_and_preserve_format_content(artifact, expected_fragment):
    parsed = ContentArtifactDraft.model_validate(artifact)
    first_markdown = render_markdown(parsed)
    second_markdown = render_markdown(parsed)
    first_json = render_json(parsed)
    assert first_markdown == second_markdown
    assert expected_fragment.encode() in first_markdown
    assert first_json == render_json(parsed)
    assert json.loads(first_json)["id"] == artifact["id"]
    assert b"createdAt" not in first_json


def test_markdown_escapes_untrusted_heading_markup():
    artifact = ContentArtifactDraft.model_validate({
        "id": "article", "outputPlanItemId": "out", "outputType": "blog_article",
        "title": "Article", "sourceSegmentRefs": ["s:1"],
        "payload": {"kind": "blog_article", "headline": "# Injected", "dek": "Dek",
                    "sections": [{"id": "s1", "heading": "[Proof](javascript:alert(1))", "body": "Body", "sourceSegmentRefs": ["s:1"]}],
                    "conclusion": "Done", "cta": "Try it", "citations": ["s:1"]},
    })
    rendered = render_markdown(artifact).decode()
    assert "javascript:" not in rendered
    assert "\\# Injected" in rendered
