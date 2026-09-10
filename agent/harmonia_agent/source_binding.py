from .canonical import typed_digest


def source_evidence_ids(analysis: dict) -> list[str]:
    return sorted({
        *[item["id"] for item in analysis["moments"]],
        *[ref for item in analysis["moments"] for ref in item["sourceSegmentRefs"]],
        *[item["id"] for item in analysis["angles"]],
        *[ref for item in analysis["angles"] for ref in item["evidenceRefs"]],
    })


def validate_source_binding(binding: dict, job_id: str, strategy_ref: dict, analysis: dict | None, items: list[dict], *, operator_context: dict | None = None) -> None:
    if analysis is None:
        if not operator_context or operator_context.get("mode") != "operator_context":
            raise ValueError("host no-source context authority required")
        if operator_context.get("contextDigest") != typed_digest(operator_context.get("operatorBrief")):
            raise ValueError("operator context digest mismatch")
        if operator_context.get("evidenceIds") != [] or operator_context.get("factualClaimsAllowed") is not False:
            raise ValueError("operator context cannot grant factual evidence")
        if binding != {**operator_context, "jobId": job_id, "strategyRef": strategy_ref}:
            raise ValueError("operator context binding mismatch")
        if any(item.get("evidenceRefs") for item in items):
            raise ValueError("operator context cannot invent factual evidence")
        return
    expected = {"jobId": job_id, "strategyRef": strategy_ref, "analysisDigest": typed_digest(analysis), "evidenceIds": source_evidence_ids(analysis)}
    if binding != expected:
        raise ValueError("editorial job source binding mismatch")
    allowed = set(binding["evidenceIds"])
    source_items = {item["id"] for item in [*analysis["moments"], *analysis["angles"]]}
    for item in items:
        refs = set(item["evidenceRefs"])
        if not refs or not refs <= allowed or not refs & source_items:
            raise ValueError("editorial item evidence is outside authoritative job sources")
