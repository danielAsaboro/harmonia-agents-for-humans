import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: "Harmonia — from source to signal to proof",
  description:
    "Autonomous content engine for startups: ingests video, transcribes, finds moments and trends, drafts platform-native posts behind human approval, publishes with audit receipts.",
  openGraph: {
    title: "Harmonia — from source to signal to proof",
    description:
      "One long-form source becomes platform-native content, human-approved publishing, and independently verified receipts.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Harmonia — From source to signal to proof." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Harmonia — from source to signal to proof",
    description:
      "One long-form source becomes platform-native content, human-approved publishing, and independently verified receipts.",
    images: ["/og.png"],
  },
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
