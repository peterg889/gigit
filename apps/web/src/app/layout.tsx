import type { Metadata } from "next";
import { Big_Shoulders, Libre_Franklin, Spline_Sans_Mono } from "next/font/google";
import Link from "next/link";

import { NavLink } from "@/components/NavLink";
import { profileCapabilitiesOwnedBy } from "@/lib/auth";
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
  const profiles = userId ? await profileCapabilitiesOwnedBy(userId) : null;
  const hasProfile = Boolean(
    profiles?.owned.performer || profiles?.owned.venue || profiles?.owned.tech,
  );
  const canPostOpenDate = Boolean(profiles?.live.venue);

  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} ${mono.variable}`}>
        <header className="site">
          <Link href="/" className="brand" aria-label="EightGig home">
            EightGig
          </Link>
          <nav aria-label="Main navigation">
            <NavLink href="/slots" exclude={["/slots/new"]}>Open gigs</NavLink>
            <NavLink href="/performers">Find an act</NavLink>
            <NavLink href="/venues">Rooms</NavLink>
            <NavLink href="/techs">Sound techs</NavLink>
            {canPostOpenDate && <NavLink href="/slots/new">Post an open date</NavLink>}
            {userId ? (
              <>
                <NavLink href="/bookings">Bookings</NavLink>
                <NavLink href="/inbox">Inbox</NavLink>
                <NavLink href={hasProfile ? "/me" : "/onboarding"}>
                  {hasProfile ? "Profiles" : "Get started"}
                </NavLink>
                <NavLink href="/account">Account</NavLink>
                <form className="nav-form" action="/api/auth/logout" method="post">
                  <button className="nav-button" type="submit">Sign out</button>
                </form>
              </>
            ) : (
              <>
                <NavLink href="/onboarding?role=venue">For venues</NavLink>
                <NavLink href="/login">Sign in</NavLink>
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
            <Link href="/dmca">Copyright</Link>
          </nav>
        </footer>
      </body>
    </html>
  );
}
