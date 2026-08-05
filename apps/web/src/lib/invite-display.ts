import { formatVenueDateTime } from "./date-time";

export function inviteSlotLabel(input: {
  startsAt: Date | string;
  timeZone: string;
  formatLabel: string;
  budgetCents: number;
}): string {
  return `${formatVenueDateTime(input.startsAt, input.timeZone)} — ${
    input.formatLabel
  } — $${(input.budgetCents / 100).toFixed(0)}`;
}
