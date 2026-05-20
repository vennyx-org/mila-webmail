import { describe, expect, it } from "vitest";
import { plainTextToComposerBody } from "../email-composer-utils";

describe("plainTextToComposerBody", () => {
  it("returns an empty string for empty input", () => {
    expect(plainTextToComposerBody("")).toBe("");
  });

  it("escapes HTML before building composer paragraphs", () => {
    expect(plainTextToComposerBody("<script>alert('x') & \"q\"</script>")).toBe(
      "<p>&lt;script&gt;alert(&#39;x&#39;) &amp; &quot;q&quot;&lt;/script&gt;</p>"
    );
  });

  it("normalizes line endings and preserves single line breaks", () => {
    expect(plainTextToComposerBody("line1\r\nline2\rline3")).toBe(
      "<p>line1<br>line2<br>line3</p>"
    );
  });

  it("splits paragraphs on blank lines", () => {
    expect(plainTextToComposerBody("first\n\nsecond\nthird")).toBe(
      "<p>first</p><p>second<br>third</p>"
    );
  });
});
