import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "RitualPredict",
  description:
    "A prediction market on Ritual Chain that reads its own oracles and settles itself.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Linked rather than bundled: a build that cannot reach Google Fonts
            still succeeds, and the fallback stack carries the page. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=Barlow:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <a className="skip" href="#markets">
          Skip to markets
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
