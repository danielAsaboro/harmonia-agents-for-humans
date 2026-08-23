# Harmonia ADK evaluations

`contracts.evalset.json` contains public, source-neutral contract cases only. Real video inputs,
transcripts, prompts, credentials, and generated results must be supplied from the private parent
workspace and written to an explicit private output path.

Live evaluation refuses to run when `HARMONIA_MOCK_AI=1` or unless
`HARMONIA_REAL_EVAL=1` is set. A public fixture passing validation is not evidence that a model or
deployment works.
