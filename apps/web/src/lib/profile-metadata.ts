/**
 * A profile is the thing people SHARE — the act sends the link to a venue, the
 * venue puts it in a group chat. Without this every share unfurled as the generic
 * site title, which wastes the one moment the product is spreading by itself.
 *
 * Fails CLOSED. An unfurl is a second, quieter way to publish a profile: the
 * crawler that renders a link preview never runs the page body, so anything
 * this returns is public no matter what the page decides. A missing row, or any
 * status other than "live" — hidden, suspended, draft, pending_review, or a
 * status invented later — therefore unfurls as "Not found" rather than leaking
 * a taken-down act's name and bio into someone's group chat.
 *
 * The page bodies keep their own notFound() gate on purpose. Two independent
 * checks on the same rule means one of them being edited or mocked away cannot
 * quietly republish the other.
 */
export function profileMetadata(
  row: { name: string; bio: string; status: string } | undefined,
  descriptionSuffix: string,
) {
  if (!row || row.status !== "live") return { title: "Not found — EightGig" };
  const description = row.bio?.slice(0, 155) || `${row.name} — ${descriptionSuffix}`;
  return {
    title: `${row.name} — EightGig`,
    description,
    openGraph: { title: row.name, description, type: "profile" },
  };
}
