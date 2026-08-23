# Harmonia ADK evaluations

`contracts.evalset.json` contains public, source-neutral contract cases only. Real video inputs,
transcripts, prompts, credentials, and generated results must be supplied from the private parent
workspace and written to an explicit private output path.

The public loader accepts only the reviewed fixture IDs, labels, typed state, prompts, expected
outputs, and trajectories committed here; arbitrary free-form text is rejected. The ADK trajectory
and response metrics complement the pure deterministic grounding, reference-preservation, and
authority evaluators in `evaluation_contracts.py`.

Live evaluation refuses to run when `HARMONIA_MOCK_AI=1`, unless `HARMONIA_REAL_EVAL=1` is set, or
without an absolute `HARMONIA_EVAL_EVIDENCE_ROOT`. The output resolves inside that private root and
outside the public repository, including through symlinks and `..` segments. A public fixture
passing validation is not evidence that a model or deployment works.
