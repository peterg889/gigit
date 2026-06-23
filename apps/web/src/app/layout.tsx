import type { Metadata } from "next";
import { Big_Shoulders, Libre_Franklin, Spline_Sans_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const display = Big_Shoulders({
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
  variable: "--font-display",
  adjustFontFallback: false,
});
const body = Libre_Franklin({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-body",
});
const mono = Spline_Sans_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Gigit — get the gig.",
  description:
    "Live music, comedy, and sound for small rooms. Every slot shows its pay. Find the room, book the night, on Gigit.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} ${mono.variable}`}>
        <header className="site">
          <Link href="/" className="brand">
            Gigit
          </Link>
          <nav>
            <Link href="/">Open slots</Link>
            <Link href="/slots/new">Post a slot</Link>
            <Link href="/performers">Find an act</Link>
            <Link href="/techs">Sound techs</Link>
            <Link href="/bookings">Bookings</Link>
            <Link href="/inbox">Inbox</Link>
            <Link href="/me">Profile</Link>
            <Link href="/login">Sign in</Link>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site">
          <span className="footer-mark">Gigit</span> — where the local scene does
          business. No fees to join or apply, ever. The pay is always on the table.
        </footer>
      </body>
    </html>
  );
}
