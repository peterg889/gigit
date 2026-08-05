"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

interface SearchParamsReader {
  get(name: string): string | null;
}

export function isNavLinkActive(
  pathname: string,
  currentSearch: SearchParamsReader,
  href: string,
  excludedPaths: readonly string[] = [],
): boolean {
  const target = new URL(href, "https://eightgig.invalid");
  const pathMatches =
    target.pathname === "/"
      ? pathname === "/"
      : pathname === target.pathname ||
        pathname.startsWith(`${target.pathname}/`);
  if (!pathMatches) return false;
  if (
    excludedPaths.some(
      (path) => pathname === path || pathname.startsWith(`${path}/`),
    )
  ) {
    return false;
  }
  for (const [key, value] of target.searchParams) {
    if (currentSearch.get(key) !== value) return false;
  }
  return true;
}

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
  exclude = [],
}: {
  href: string;
  children: React.ReactNode;
  /** More-specific sibling routes that should win this prefix match. */
  exclude?: string[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = isNavLinkActive(pathname, searchParams, href, exclude);
  return (
    <Link href={href} aria-current={active ? "page" : undefined}>
      {children}
    </Link>
  );
}
