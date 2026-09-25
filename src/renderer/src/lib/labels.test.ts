import { describe, expect, it } from "vitest";
import { buildLabelHtml, parseLabelSize } from "./labels";

describe("parseLabelSize", () => {
  it("parses the three known LABEL_SIZES options", () => {
    expect(parseLabelSize("80×50 مم")).toEqual({ widthMm: 80, heightMm: 50 });
    expect(parseLabelSize("58×40 مم")).toEqual({ widthMm: 58, heightMm: 40 });
    expect(parseLabelSize("40×30 مم")).toEqual({ widthMm: 40, heightMm: 30 });
  });

  it("falls back to a sane default for null/empty/unparseable input", () => {
    expect(parseLabelSize(null)).toEqual({ widthMm: 58, heightMm: 40 });
    expect(parseLabelSize(undefined)).toEqual({ widthMm: 58, heightMm: 40 });
    expect(parseLabelSize("")).toEqual({ widthMm: 58, heightMm: 40 });
    expect(parseLabelSize("not a size")).toEqual({ widthMm: 58, heightMm: 40 });
  });

  it("also accepts a plain ascii x separator", () => {
    expect(parseLabelSize("100x60")).toEqual({ widthMm: 100, heightMm: 60 });
  });
});

describe("buildLabelHtml", () => {
  it("prints the variant name under the product name when given, escaped", () => {
    const html = buildLabelHtml({
      productName: "قميص",
      variantName: "أحمر <XL>",
      price: 1200,
      barcodeValue: "VAR-1",
      barcodeDataUrl: null,
      widthMm: 58,
      heightMm: 40,
    });
    expect(html).toContain('<p class="variant">أحمر &lt;XL&gt;</p>');
    expect(html).toContain("VAR-1");
  });

  it("omits the variant line for the base product", () => {
    const html = buildLabelHtml({ productName: "قميص", price: null, barcodeValue: null, barcodeDataUrl: null, widthMm: 58, heightMm: 40 });
    expect(html).not.toContain('class="variant"');
  });
});
