import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { MutationListener } from "./_components/MutationListener";
import { AppChrome } from "./_components/AppChrome";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "GovScout — Proposal Drafting",
  description: "AI-powered grant proposal drafting for Acme Consulting and the NJ Thrive consortium.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="gs-canvas min-h-screen text-stone-900 antialiased">
        <MutationListener />
        <AppChrome>{children}</AppChrome>
      </body>
    </html>
  );
}
