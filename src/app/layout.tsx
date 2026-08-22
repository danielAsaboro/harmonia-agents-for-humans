import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Harmonia — social content agent",
  description:
    "Autonomous content engine for startups: ingests video, transcribes, finds moments and trends, drafts platform-native posts behind human approval, publishes with audit receipts.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
