import type { Metadata } from "next";
import "./ios26.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tessera Invoice Inbox",
  description:
    "Upload an invoice or receipt and get structured, review-ready JSON with per-field confidence. Extraction runs on the native Anthropic API.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
