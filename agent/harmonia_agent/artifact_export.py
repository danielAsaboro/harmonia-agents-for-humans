"""Deterministic, side-effect-free content artifact serialization."""

from __future__ import annotations

import json
import re

from .content_artifacts import ContentArtifactDraft


def _heading(value: str) -> str:
    value = re.sub(r"(?i)javascript\s*:", "", value)
    return re.sub(r"([\\`*_[\]<>#+.!|-])", r"\\\1", value).strip()


def render_json(artifact: ContentArtifactDraft) -> bytes:
    value = artifact.model_dump(mode="json", by_alias=True, exclude_none=True)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def render_markdown(artifact: ContentArtifactDraft) -> bytes:
    payload = artifact.payload.model_dump(mode="json", by_alias=True, exclude_none=True)
    kind = payload["kind"]
    lines = [f"# {_heading(artifact.title)}", ""]
    if kind == "x_post":
        lines.append(payload["text"])
    elif kind == "x_thread":
        for index, post in enumerate(payload["posts"], 1):
            lines.extend([f"## Post {index}", "", post["text"], ""])
    elif kind == "linkedin_post":
        if payload.get("title"): lines.extend([f"## {_heading(payload['title'])}", ""])
        lines.append(payload["body"])
        if payload.get("cta"): lines.extend(["", payload["cta"]])
    elif kind == "blog_article":
        lines = [f"# {_heading(payload['headline'])}", "", payload["dek"], ""]
        for section in payload["sections"]: lines.extend([f"## {_heading(section['heading'])}", "", section["body"], ""])
        lines.extend(["## Conclusion", "", payload["conclusion"], "", payload["cta"], "", "## Sources", "", *[f"- `{ref}`" for ref in payload["citations"]]])
    elif kind == "newsletter":
        lines.extend([f"**Subject:** {payload['subject']}", "", f"**Preheader:** {payload['preheader']}", "", payload["introduction"], ""])
        for section in payload["sections"]: lines.extend([f"## {_heading(section['heading'])}", "", section["body"], ""])
        lines.append(payload["cta"])
        if payload.get("signOff"): lines.extend(["", payload["signOff"]])
    elif kind == "caption":
        lines.extend([f"**Platform:** {payload['platformIntent']}", "", payload["text"]])
        if payload.get("cta"): lines.extend(["", payload["cta"]])
        if payload.get("hashtags"): lines.extend(["", " ".join(payload["hashtags"])])
    elif kind == "carousel_spec":
        for index, slide in enumerate(payload["slides"], 1): lines.extend([f"## Slide {index}: {_heading(slide['headline'])}", "", slide["body"], "", f"Role: `{slide['role']}`", ""])
    elif kind == "quote_card":
        lines.extend([f"> {payload['quote']}", "", f"— {payload['attribution']}", "", f"Render brief: {payload['renderBrief']}"])
    elif kind == "diagram":
        lines.extend([f"**Diagram type:** {payload['diagramType']}", "", payload["renderBrief"], "", "## Nodes", ""])
        lines.extend(f"- `{node['id']}`: {node['label']}" for node in payload["nodes"])
        lines.extend(["", "## Edges", ""])
        lines.extend(f"- `{edge['from']}` → `{edge['to']}`{': ' + edge['label'] if edge.get('label') else ''}" for edge in payload["edges"])
    elif kind == "editorial_calendar":
        lines.extend(["| Intended at | Channel | Artifact | Purpose |", "|---|---|---|---|"])
        lines.extend(f"| {entry['intendedAt']} | {entry['channel']} | `{entry['artifactId']}` | {entry['purpose']} |" for entry in payload["entries"])
    elif kind == "content_pack":
        lines.extend(["## Verified artifacts", "", *[f"- `{item['artifactId']}` — `{item['digest']}`" for item in payload["artifacts"]]])
    else:
        raise ValueError(f"unsupported artifact kind: {kind}")
    return ("\n".join(lines).rstrip() + "\n").encode("utf-8")
