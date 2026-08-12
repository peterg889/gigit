import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The palette is dark-on-dark by design ("gig poster, not SaaS"), which is
 * exactly the palette where a boundary or a hint quietly falls under the
 * threshold and nobody notices until an audit. These numbers are computed from
 * globals.css itself, so a future re-tint of --line-strong or of the placeholder
 * alpha fails here instead of shipping.
 */
// Comments stripped first: this stylesheet explains itself at length, and a
// prose "1.11:1 on --panel" inside a rule otherwise swallows the declaration
// that follows it.
const css = readFileSync(path.join(__dirname, "globals.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|,|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"));
  const body = match?.[1];
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  return body;
}

function declaration(selector: string, property: string): string {
  const match = block(selector).match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`));
  const value = match?.[1];
  if (value === undefined) throw new Error(`no ${property} in ${selector}`);
  return value.trim();
}

/** Resolve `var(--x)` against the `:root` block, so the test reads real values. */
function customProperty(name: string): string {
  const match = block(":root").match(new RegExp(`(?:^|;)\\s*${name}\\s*:([^;]*)`));
  const value = match?.[1];
  if (value === undefined) throw new Error(`no ${name} in :root`);
  return value.trim();
}

type Rgb = [number, number, number];

function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const varName = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (varName) return parseColor(customProperty(varName));

  const rgbaBody = value.match(/^rgba?\(([^)]*)\)$/)?.[1];
  if (rgbaBody) {
    const parts = rgbaBody.split(",").map((part) => Number(part.trim()));
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined)
      throw new Error(`cannot parse color ${value}`);
    return { rgb: [r, g, b], alpha: a ?? 1 };
  }

  const hexDigits = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hexDigits) throw new Error(`cannot parse color ${value}`);
  const n = parseInt(hexDigits, 16);
  return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
}

/** WCAG relative luminance (sRGB). */
function luminance([r, g, b]: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** What the eye actually sees when a translucent color sits on an opaque one. */
function composite(fg: { rgb: Rgb; alpha: number }, bg: Rgb): Rgb {
  return fg.rgb.map((c, i) => fg.alpha * c + (1 - fg.alpha) * (bg[i] ?? 0)) as Rgb;
}

function contrast(front: string, behind: string): number {
  const bg = parseColor(behind).rgb;
  const fg = composite(parseColor(front), bg);
  const [hi = 0, lo = 0] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every surface a transparent control can be drawn on top of. */
const backgrounds = ["--room", "--panel", "--panel-deep"] as const;

describe("form and control contrast in the dark palette", () => {
  // WCAG 1.4.11: the boundary that tells you a control is a control needs 3:1.
  it.each([
    ["button.quiet, .btn.quiet", "quiet button"],
    [".filter-chip", "filter chip"],
  ])("draws the %s border at 3:1 or better on every card", (selector) => {
    const border = declaration(selector, "border").split(/\s+/).pop() as string;
    for (const surface of backgrounds) {
      expect(
        contrast(border, `var(${surface})`),
        `${selector} border on ${surface}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("draws the input border at 3:1 or better on every card", () => {
    const border = declaration("input, select, textarea", "border")
      .split(/\s+/)
      .pop() as string;
    for (const surface of backgrounds) {
      expect(
        contrast(border, `var(${surface})`),
        `input border on ${surface}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  // WCAG 1.4.3: a placeholder is text, at body size, so 4.5:1.
  it("keeps the placeholder readable against the field it sits in", () => {
    const field = declaration("input, select, textarea", "background");
    const placeholder = declaration(
      "input::placeholder, textarea::placeholder",
      "color",
    );

    expect(contrast(placeholder, field)).toBeGreaterThanOrEqual(4.5);
    // ...while still reading as a hint rather than as a filled-in value: it is
    // markedly dimmer than entered text, and italic carries the rest.
    expect(contrast("var(--ink)", field)).toBeGreaterThan(
      contrast(placeholder, field) * 2,
    );
    expect(
      declaration("input::placeholder, textarea::placeholder", "font-style"),
    ).toBe("italic");
  });
});

describe("user-authored text", () => {
  it("has one class that preserves the newlines an author typed", () => {
    expect(declaration(".user-text", "white-space")).toBe("pre-wrap");
  });
});
