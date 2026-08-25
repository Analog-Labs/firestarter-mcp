/**
 * HTML escaping for the widget's string-built markup.
 *
 * Every product title, seller name and review quote in this widget is
 * third-party text — a seller writes it, a buyer writes it, or a feed supplies
 * it — and the view builds markup by string concatenation. This function is the
 * only thing standing between that text and the DOM, so it moved out of the
 * client module (which Node cannot import) to somewhere it can be tested.
 */
import { describe, it, expect } from "vitest";
import { esc } from "../../src/mcp/ui/escape.js";

describe("esc", () => {
  it("neutralises a script tag in a product title", () => {
    expect(esc('<script>alert(1)</script>')).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes the quotes that would break out of an attribute", () => {
    // Titles land in alt="" and data-url="" — an unescaped quote there is an
    // injection point, not a cosmetic bug.
    expect(esc(`" onerror="x`)).toBe("&quot; onerror=&quot;x");
    expect(esc("it's")).toBe("it&#39;s");
  });

  it("escapes ampersands so an entity cannot be smuggled in", () => {
    expect(esc("Wax & Hide")).toBe("Wax &amp; Hide");
  });

  it("renders nothing for absent text rather than the word undefined", () => {
    expect(esc(undefined)).toBe("");
    expect(esc(null)).toBe("");
  });
});
