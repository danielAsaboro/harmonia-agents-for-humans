from harmonia_agent.canonical import typed_digest
from harmonia_agent.source_binding import source_evidence_ids


def source_binding(job_id, ref, analysis):
    return {"jobId": job_id, "strategyRef": ref, "analysisDigest": typed_digest(analysis),
            "evidenceIds": source_evidence_ids(analysis)}


def bind_job_plan(job_id, job, snapshot):
    snapshot["sourceBinding"] = source_binding(job_id, job["strategyRef"], job["sourceAnalysis"])
    job["editorialPlanningSnapshot"] = snapshot
    job["editorialPlanningSnapshotDigest"] = typed_digest(snapshot)
    job["editorialPlan"]["planningSnapshotDigest"] = typed_digest(snapshot)
    job["editorialPlanDigest"] = typed_digest(job["editorialPlan"])


def artifact_authority():
    from tests.test_temi_editorial_plan import analysis, plan
    evidence = analysis()
    evidence["moments"][0]["sourceSegmentRefs"] = ["source-1:seg-1"]
    ref = {"workspaceId": "w1", "brandId": "b1", "strategyId": "s1", "revision": 8, "digest": "a" * 64}
    return {"sourceBinding": source_binding("job-1", ref, evidence), "editorialItem": plan()["items"][0]}
