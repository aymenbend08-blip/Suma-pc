import { describe, expect, it } from "vitest";
import { parseLabelSize } from "./labels";

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
