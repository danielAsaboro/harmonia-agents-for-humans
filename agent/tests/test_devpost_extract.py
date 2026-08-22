from closefold_agent.devpost import extract_sections

FIXTURE = """
<html><body><div id="app-body">
<h1>All Things Agentic Hackathon</h1>
<p>An online hackathon sponsored by Google LLC and administered by Devpost.</p>
<h2>Requirements</h2>
<p>You must build an autonomous agent using Gemini 3.5 or newer through the Gemini API.</p>
<ul><li>Provide a public repository with setup instructions for reviewers.</li></ul>
<h2>Judging criteria</h2>
<p>Innovation and operational utility weighs forty percent of the total score.</p>
<h2>Prizes</h2>
<p>Grand prize winners receive cash plus Google Cloud credits.</p>
</div></body></html>
"""


def test_extracts_headings_with_bodies():
    result = extract_sections(FIXTURE)
    assert "Requirements" in result["sections"]
    assert "Judging criteria" in result["sections"]
    text = result["text"]
    assert "Gemini 3.5" in text
    assert "forty percent" in text


def test_short_paragraphs_are_ignored():
    result = extract_sections("<html><body><div id='app-body'><h2>FAQ</h2><p>short</p></div></body></html>")
    assert result["sections"] == []
    assert result["text"] == ""


def test_repeated_headings_get_distinct_buckets():
    html = (
        "<html><body><div id='app-body'>"
        "<h2>Rules</h2><p>The first rules block describes eligibility limits.</p>"
        "<h2>Rules</h2><p>The second rules block describes submission deadlines.</p>"
        "</div></body></html>"
    )
    result = extract_sections(html)
    assert len([s for s in result["sections"] if s.startswith("Rules")]) >= 2
