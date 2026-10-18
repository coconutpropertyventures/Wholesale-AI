import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wholesale AI — Coconut Property Ventures",
  description:
    "Single-screen command center for real estate wholesaling, turnkey rental acquisitions, and land deals.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
