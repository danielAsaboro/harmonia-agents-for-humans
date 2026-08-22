import type { Metadata } from "next";
import "./globals.css";


export const metadata: Metadata = {
  title: "Closefold — submission-evidence agent",
  description:
    "Autonomous agent that closes submission-evidence gaps: live requirement ingestion, repository and deployment audits, policy-gated corrective actions, independent verification.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
