import type { JobFull } from "@/components/Dashboard";

export function evidenceJson(job: JobFull): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      job: {
        id: job.id,
        status: job.status,
        stage: job.stage,
        config: job.config,
        failure: job.failure ?? null,
      },
      rubric: job.rubric,
      findings: job.findings,
      observations: job.observations ?? [],
      actions: job.actions,
      verifications: job.verifications ?? [],
      packet: job.packet ?? null,
    },
    null,
    2,
  );
}

export function evidenceMarkdown(job: JobFull): string {
  const lines: string[] = [];
  const verifiedCount = (job.verifications ?? []).filter((v) => v.verified).length;

  lines.push(`# Closefold Evidence Packet — job \`${job.id.slice(0, 8)}\``);
  lines.push("");
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Status: ${job.status} (stage: ${job.stage})`);
  lines.push(`- Source: ${job.config.devpostUrl}`);
  lines.push(`- Repository: ${job.config.githubOwner}/${job.config.githubRepo}`);
  if (job.config.cloudRunUrl) lines.push(`- Deployment: ${job.config.cloudRunUrl}`);
  lines.push("");

  lines.push("## Rubric");
  lines.push("");
  lines.push("| # | Requirement | Category | Status | Verified |");
  lines.push("|---|-------------|----------|--------|----------|");
  const verificationFor = (id: string) =>
    (job.verifications ?? []).find((v) => v.rubricItemId === id && v.verified);
  job.rubric.forEach((item, i) => {
    const v = verificationFor(item.id);
    lines.push(
      `| ${i + 1} | ${item.requirement.replace(/\|/g, "\\|")} | ${item.category} | ${item.status} | ${v ? `yes (${v.method})` : "no"} |`,
    );
  });
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  for (const f of job.findings) {
    lines.push(`- **${f.rubricItemId}** — ${f.status}: ${f.rationale}`);
    for (const ev of f.evidence) {
      lines.push(`  - Evidence: ${ev.url}${ev.digest ? ` (sha256 ${ev.digest.slice(0, 16)}…)` : ""}`);
    }
  }
  lines.push("");

  if ((job.observations?.length ?? 0) > 0) {
    lines.push("## Collected observations");
    lines.push("");
    for (const o of job.observations ?? []) {
      lines.push(`- [${o.ok ? "ok" : "fail"}] ${o.kind}: ${o.target}${o.httpStatus ? ` (HTTP ${o.httpStatus})` : ""}`);
      if (o.digest) lines.push(`  - sha256: ${o.digest}`);
    }
    lines.push("");
  }

  lines.push("## Corrective actions & receipts");
  lines.push("");
  for (const a of job.actions) {
    lines.push(`- ${a.title} — state: ${a.state}, approval: ${a.approvalState}, risk: ${a.risk}`);
  }
  lines.push("");

  lines.push("## Verification results");
  lines.push("");
  for (const v of job.verifications ?? []) {
    lines.push(`- ${v.rubricItemId}: ${v.verified ? "VERIFIED" : "NOT VERIFIED"} via ${v.method}${v.note ? ` — ${v.note}` : ""}`);
  }
  lines.push("");
  lines.push(`Verified ${verifiedCount}/${(job.verifications ?? []).length} checks.`);
  lines.push("");

  if (job.packet && job.packet.unresolved.length > 0) {
    lines.push("## Unresolved gaps");
    lines.push("");
    for (const u of job.packet.unresolved) lines.push(`- ${u}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function download(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
