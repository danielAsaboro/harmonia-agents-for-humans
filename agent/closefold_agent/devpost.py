"""Live Devpost ingestion: fetch the public hackathon page and extract the
requirement-bearing sections as plain text for rubric normalization."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

import httpx
from bs4 import BeautifulSoup

USER_AGENT = "Closefold/1.0 (+submission-evidence-agent)"


class SourceFetchError(RuntimeError):
    pass


@dataclass
class IngestedSource:
    url: str
    http_status: int
    bytes_downloaded: int
    digest: str
    title: str
    sections: list[str] = field(default_factory=list)
    text: str = ""


def fetch_source(url: str) -> IngestedSource:
    with httpx.Client(follow_redirects=True, timeout=30) as client:
        res = client.get(url, headers={"User-Agent": USER_AGENT})
    if res.status_code != 200:
        raise SourceFetchError(f"devpost fetch returned HTTP {res.status_code}")
    body = res.text.encode("utf-8")
    soup = BeautifulSoup(res.text, "html.parser")
    return IngestedSource(
        url=url,
        http_status=res.status_code,
        bytes_downloaded=len(body),
        digest=hashlib.sha256(body).hexdigest(),
        title=soup.title.string.strip() if soup.title and soup.title.string else "",
        **extract_sections(res.text),
    )


def extract_sections(html: str) -> dict[str, list[str] | str]:
    """Extract headings and their body text from a Devpost-style page.

    Deterministic parsing only; no model involvement at this stage.
    """
    soup = BeautifulSoup(html, "html.parser")
    main = soup.select_one("#app-body") or soup.body or soup

    sections: list[str] = []
    chunks: list[str] = []
    seen_headings: set[str] = set()

    current_heading = ""
    buffer: list[str] = []

    def flush() -> None:
        nonlocal current_heading, buffer
        if current_heading and buffer:
            text = "\n".join(line.strip() for line in buffer if line.strip())
            if text:
                sections.append(current_heading)
                chunks.append(f"## {current_heading}\n{text}")
        current_heading = ""
        buffer = []

    for el in main.find_all(["h1", "h2", "h3", "h4", "p", "li"]):
        if el.name in ("h1", "h2", "h3", "h4"):
            heading = el.get_text(" ", strip=True)
            if not heading:
                continue
            flush()
            if heading in seen_headings:
                current_heading = f"{heading} (repeated)"
            else:
                current_heading = heading
                seen_headings.add(heading)
        else:
            text = el.get_text(" ", strip=True)
            if text and len(text) > 40:
                buffer.append(text)
    flush()

    return {"sections": sections[:60], "text": "\n\n".join(chunks)[:120000]}
