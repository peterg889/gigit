"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * A nav link that knows whether it's the current page.
 *
 * `:hover` was the only state the nav had, and touch devices don't hover — so on
 * the surface people use most there was no indication of where they were.
 * `aria-current="page"` drives both the visual state and the screen-reader one.
 */
export function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // Exact match for "/", prefix match otherwise, so /slots/new still marks
  // "Post an open date" rather than lighting up "Open gigs" as well.
  const active =
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} aria-current={active ? "page" : undefined}>
      {children}
    </Link>
  );
}
