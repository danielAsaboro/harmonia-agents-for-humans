import { Suspense } from "react";
import "@xyflow/react/dist/style.css";
import { ArchitectureExplorer } from "@/components/architecture/ArchitectureExplorer";
import "./architecture.css";

export default function ArchitecturePage() {
  return <Suspense fallback={<div className="architecture-loading">Loading architecture…</div>}><ArchitectureExplorer /></Suspense>;
}
