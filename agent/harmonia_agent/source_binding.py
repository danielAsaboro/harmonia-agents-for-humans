from .canonical import typed_digest


def source_evidence_ids(analysis: dict) -> list[str]:
    return sorted({
        *[item["id"] for item in analysis["moments"]],
        *[ref for item in analysis["moments"] for ref in item["sourceSegmentRefs"]],
        *[item["id"] for item in analysis["angles"]],
        *[ref for item in analysis["angles"] for ref in item["evidenceRefs"]],
    })


def validate_source_binding(binding: dict, job_id: str, strategy_ref: dict, analysis: dict, items: list[dict]) -> None:
    expected = {"jobId": job_id, "strategyRef": strategy_ref, "analysisDigest": typed_digest(analysis), "evidenceIds": source_evidence_ids(analysis)}
    if binding != expected:
        raise ValueError("editorial job source binding mismatch")
    allowed = set(binding["evidenceIds"])
    source_items = {item["id"] for item in [*analysis["moments"], *analysis["angles"]]}
    for item in items:
        refs = set(item["evidenceRefs"])
        if not refs or not refs <= allowed or not refs & source_items:
            raise ValueError("editorial item evidence is outside authoritative job sources")
