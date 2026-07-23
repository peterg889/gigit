import type { Metadata } from "next";
import { Big_Shoulders, Libre_Franklin, Spline_Sans_Mono } from "next/font/google";
import Link from "next/link";
import { performerOwnedBy, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
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
  title: "EightGig — get the gig.",
  description:
    "EightGig helps independent venues book local bands, solo acts, comedians, and sound techs. Every open gig shows its pay.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon-eightgig.svg" },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const userId = await sessionUserId();
  const [performer, venue, tech] = userId
    ? await Promise.all([
        performerOwnedBy(userId),
        venueOwnedBy(userId),
        techOwnedBy(userId),
      ])
    : [null, null, null];
  const hasProfile = Boolean(performer || venue || tech);

  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} ${mono.variable}`}>
        <header className="site">
          <Link href="/" className="brand" aria-label="EightGig home">
            EightGig
          </Link>
          <nav aria-label="Main navigation">
            <Link href="/slots">Open gigs</Link>
            <Link href="/performers">Find an act</Link>
            <Link href="/techs">Sound techs</Link>
            {venue && <Link href="/slots/new">Post an open date</Link>}
            {userId ? (
              <>
                <Link href="/bookings">Bookings</Link>
                <Link href="/inbox">Inbox</Link>
                <Link href={hasProfile ? "/me" : "/onboarding"}>
                  {hasProfile ? "Profiles" : "Get started"}
                </Link>
                <Link href="/account">Account</Link>
                <form className="nav-form" action="/api/auth/logout" method="post">
                  <button className="nav-button" type="submit">Sign out</button>
                </form>
              </>
            ) : (
              <>
                <Link href="/onboarding?role=venue">For venues</Link>
                <Link href="/login">Sign in</Link>
              </>
            )}
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site">
          <div>
            <span className="footer-mark">EightGig</span> — where independent venues and
            local acts book gigs. Free during beta, and the first 500 acts and
            venues to join become Founding Members.
          </div>
          <nav aria-label="Footer navigation">
            <Link href="/about">About</Link>
            <Link href="/help">Help &amp; Support</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </nav>
        </footer>
      </body>
    </html>
  );
}
