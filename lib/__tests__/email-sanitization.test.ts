import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';
import {
  sanitizeEmailHtml,
  sanitizeSignatureHtml,
  parseHtmlSafely,
  hasRichFormatting,
  plainTextToSafeHtml,
  EMAIL_SANITIZE_CONFIG,
} from '../email-sanitization';

describe('email-sanitization', () => {
  describe('sanitizeEmailHtml', () => {
    it('should remove script tags', () => {
      const malicious = '<p>Hello</p><script>alert("XSS")</script>';
      const clean = sanitizeEmailHtml(malicious);
      expect(clean).not.toContain('<script>');
      expect(clean).toContain('Hello');
    });

    it('should remove event handlers', () => {
      const malicious = '<img src="x" onerror="alert(\'XSS\')">';
      const clean = sanitizeEmailHtml(malicious);
      expect(clean).not.toContain('onerror');
    });

    it('should remove iframe, object, embed tags', () => {
      const malicious = '<div>Content</div><iframe src="evil.com"></iframe><object></object>';
      const clean = sanitizeEmailHtml(malicious);
      expect(clean).not.toContain('<iframe');
      expect(clean).not.toContain('<object');
      expect(clean).toContain('Content');
    });

    it('should remove meta, link, base tags', () => {
      const malicious = '<p>Text</p><meta charset="utf-8"><link rel="stylesheet" href="evil.css">';
      const clean = sanitizeEmailHtml(malicious);
      expect(clean).not.toContain('<meta');
      expect(clean).not.toContain('<link');
      expect(clean).toContain('Text');
    });

    it('should preserve safe HTML structure', () => {
      const safe = '<p>Paragraph</p><div><span>Nested</span></div><table><tr><td>Cell</td></tr></table>';
      const clean = sanitizeEmailHtml(safe);
      expect(clean).toContain('<p>');
      expect(clean).toContain('<div>');
      expect(clean).toContain('<table>');
      expect(clean).toContain('Cell');
    });

    it('should preserve safe attributes', () => {
      const withAttrs = '<p style="color: red;" class="text">Styled</p>';
      const clean = sanitizeEmailHtml(withAttrs);
      expect(clean).toContain('style');
      expect(clean).toContain('class');
    });

    it('should handle empty input', () => {
      expect(sanitizeEmailHtml('')).toBe('');
      expect(sanitizeEmailHtml('   ')).toBeTruthy();
    });

    it('should handle malformed HTML', () => {
      const malformed = '<p>Unclosed<div>Tags';
      const clean = sanitizeEmailHtml(malformed);
      expect(clean).toContain('Unclosed');
      expect(clean).toContain('Tags');
    });
  });

  describe('sanitizeSignatureHtml', () => {
    it('should allow basic formatting tags', () => {
      const signature = '<p><strong>John Doe</strong><br><em>Software Engineer</em></p>';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).toContain('<strong>');
      expect(clean).toContain('<em>');
      expect(clean).toContain('John Doe');
    });

    it('should allow img with https src', () => {
      const signature = '<p>John</p><img src="https://cdn.example.com/logo.png" alt="Logo" width="120" height="40">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).toContain('<img');
      expect(clean).toContain('src="https://cdn.example.com/logo.png"');
      expect(clean).toContain('alt="Logo"');
      expect(clean).toContain('width="120"');
      expect(clean).toContain('height="40"');
    });

    it('should allow img with data:image/png;base64 src', () => {
      const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAAAXRSTlPM0jRW/QAAAAlwSFlzAAALEwAACxMBAJqcGAAAAA1JREFUCNdjYGBgAAAABAABc7Rs9wAAAABJRU5ErkJggg==';
      const signature = `<img src="${dataUri}" alt="Logo">`;
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).toContain('<img');
      expect(clean).toContain('data:image/png;base64,');
    });

    it('should allow img with data:image/jpeg, gif, webp', () => {
      const cases = ['data:image/jpeg;base64,AAA', 'data:image/jpg;base64,AAA', 'data:image/gif;base64,AAA', 'data:image/webp;base64,AAA'];
      for (const src of cases) {
        const clean = sanitizeSignatureHtml(`<img src="${src}" alt="x">`);
        expect(clean).toContain('<img');
        expect(clean).toContain(src);
      }
    });

    it('should strip img with http: src (https only)', () => {
      const signature = '<img src="http://insecure.example.com/logo.png" alt="Logo">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('http://insecure.example.com');
      expect(clean).not.toContain('<img');
    });

    it('should strip img with javascript: src', () => {
      const signature = '<img src="javascript:alert(1)" alt="x">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('javascript:');
      expect(clean).not.toContain('<img');
    });

    it('should strip img with data:image/svg+xml src (SVG forbidden)', () => {
      const signature = '<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="x">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('data:image/svg');
      expect(clean).not.toContain('<img');
    });

    it('should strip img with non-image data: URI', () => {
      const signature = '<img src="data:text/html;base64,PHA+aGk8L3A+" alt="x">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('data:text/html');
      expect(clean).not.toContain('<img');
    });

    it('should strip event handlers on img', () => {
      const signature = '<img src="https://cdn.example.com/logo.png" alt="x" onerror="alert(1)" onload="alert(2)">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('onerror');
      expect(clean).not.toContain('onload');
      expect(clean).toContain('https://cdn.example.com/logo.png');
    });

    it('should remove video and audio tags', () => {
      const signature = '<p>John</p><video src="vid.mp4"></video><audio src="sound.mp3"></audio>';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('<video');
      expect(clean).not.toContain('<audio');
    });

    it('should preserve links with safe attributes', () => {
      const signature = '<p><a href="https://example.com" style="color: blue;">Website</a></p>';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).toContain('<a');
      expect(clean).toContain('href');
      expect(clean).toContain('example.com');
    });

    it('should remove script tags', () => {
      const malicious = '<p>Signature</p><script>alert("XSS")</script>';
      const clean = sanitizeSignatureHtml(malicious);
      expect(clean).not.toContain('<script>');
      expect(clean).toContain('Signature');
    });

    it('should handle empty signatures', () => {
      expect(sanitizeSignatureHtml('')).toBe('');
      expect(sanitizeSignatureHtml('   ')).toBe('');
    });

    it('should be stricter than email sanitization for script-bearing tags', () => {
      const html = '<p>Text</p><table><tr><td>Data</td></tr></table><video src="v.mp4"></video><iframe src="x"></iframe>';
      const emailClean = sanitizeEmailHtml(html);
      const signatureClean = sanitizeSignatureHtml(html);

      // Both preserve tables (signatures are universally table-based)
      expect(emailClean).toContain('<table>');
      expect(signatureClean).toContain('<table');
      expect(signatureClean).toContain('Data');

      // Signature still blocks media and frames
      expect(signatureClean).not.toContain('<video');
      expect(signatureClean).not.toContain('<iframe');
      expect(signatureClean).toContain('Text');
    });

    it('should preserve table layout attributes used by email signatures', () => {
      const signature = '<table cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" align="left" bgcolor="#fafafa" colspan="2">Name</td></tr></table>';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).toContain('cellpadding');
      expect(clean).toContain('cellspacing');
      expect(clean).toContain('valign');
      expect(clean).toContain('align');
      expect(clean).toContain('bgcolor');
      expect(clean).toContain('colspan');
    });
  });

  describe('parseHtmlSafely', () => {
    it('should return a valid Document', () => {
      const html = '<p>Test</p>';
      const doc = parseHtmlSafely(html);
      expect(doc).toBeInstanceOf(Document);
    });

    it('should not execute scripts', () => {
      let executed = false;
      const html = '<script>executed = true;</script>';
      parseHtmlSafely(html);
      expect(executed).toBe(false);
    });

    it('should handle malformed HTML gracefully', () => {
      const malformed = '<p>Unclosed<div>Tags';
      const doc = parseHtmlSafely(malformed);
      expect(doc).toBeInstanceOf(Document);
      expect(doc.body.textContent).toContain('Unclosed');
    });
  });

  describe('hasRichFormatting', () => {
    it('should detect tables', () => {
      const html = '<table><tr><td>Data</td></tr></table>';
      expect(hasRichFormatting(html)).toBe(true);
    });

    it('should detect images', () => {
      const html = '<img src="pic.jpg">';
      expect(hasRichFormatting(html)).toBe(true);
    });

    it('should detect inline styles', () => {
      const html = '<div style="color: red;">Styled</div>';
      expect(hasRichFormatting(html)).toBe(true);
    });

    it('should detect formatting tags', () => {
      expect(hasRichFormatting('<b>Bold</b>')).toBe(true);
      expect(hasRichFormatting('<strong>Strong</strong>')).toBe(true);
      expect(hasRichFormatting('<em>Emphasized</em>')).toBe(true);
    });

    it('should detect headings', () => {
      expect(hasRichFormatting('<h1>Title</h1>')).toBe(true);
      expect(hasRichFormatting('<h3>Subtitle</h3>')).toBe(true);
    });

    it('should detect lists', () => {
      expect(hasRichFormatting('<ul><li>Item</li></ul>')).toBe(true);
      expect(hasRichFormatting('<ol><li>Item</li></ol>')).toBe(true);
    });

    it('should return false for plain text', () => {
      const plain = '<p>Just plain text</p>';
      expect(hasRichFormatting(plain)).toBe(false);
    });

    it('should return false for simple paragraphs', () => {
      const simple = '<p>Line 1</p><p>Line 2</p>';
      expect(hasRichFormatting(simple)).toBe(false);
    });

    it('should handle empty HTML', () => {
      expect(hasRichFormatting('')).toBe(false);
      expect(hasRichFormatting('   ')).toBe(false);
    });
  });

  describe('inline CID image handling', () => {
    it('should preserve blob: URLs for CID-replaced images (not treated as external)', () => {
      // Simulate what the component does: replace cid: with blob: object URLs
      const html = '<p>See image:</p><img src="blob:http://localhost/abc-123">';
      const clean = sanitizeEmailHtml(html);
      expect(clean).toContain('blob:');
    });

    it('should preserve data: URLs for CID placeholder images', () => {
      const html = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">';
      const clean = sanitizeEmailHtml(html);
      expect(clean).toContain('data:image/gif');
    });

    it('should not leave raw JMAP download URLs after CID replacement pattern', () => {
      // This tests the regex pattern used for CID replacement
      const htmlWithCid = '<img src="cid:image001@example.com">';
      // Simulate the component's replacement: all cid: refs should become blob: or data: URLs
      const replaced = htmlWithCid.replace(
        /\bcid:([^"'\s)]+)/gi,
        () => 'blob:http://localhost/safe-object-url'
      );
      expect(replaced).not.toContain('cid:');
      expect(replaced).toContain('blob:');
    });

    it('should block external http(s) images but not blob/data URLs via DOMPurify hook', () => {
      const html = `
        <img src="blob:http://localhost/inline-ok">
        <img src="https://tracker.evil.com/pixel.png">
        <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
      `;

      const config = { ...EMAIL_SANITIZE_CONFIG };

      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'IMG') {
          const src = node.getAttribute('src');
          if (src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//'))) {
            node.setAttribute('data-blocked-src', src);
            node.removeAttribute('src');
            node.setAttribute('alt', '[Image blocked]');
          }
        }
      });

      const clean = DOMPurify.sanitize(html, config);
      DOMPurify.removeAllHooks();

      // External https image should be blocked
      expect(clean).toContain('data-blocked-src');
      expect(clean).toContain('tracker.evil.com');
      // blob: and data: URLs should NOT be blocked (they don't start with http/https)
      expect(clean).toContain('blob:');
      expect(clean).toContain('data:image/gif');
    });
  });

  describe('plainTextToSafeHtml', () => {
    it('escapes HTML-special characters in surrounding text', () => {
      const result = plainTextToSafeHtml('<script>alert(1)</script> & "q" \'q\'');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
      expect(result).toContain('&amp;');
      expect(result).toContain('&quot;');
      expect(result).toContain('&#39;');
    });

    it('linkifies http(s) URLs', () => {
      const result = plainTextToSafeHtml('visit http://example.com/path now');
      expect(result).toContain('<a href="http://example.com/path"');
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener noreferrer"');
    });

    it('prevents attribute breakout via quote in URL (CVE regression)', () => {
      const payload = 'http://evil.tld/"onmouseover="alert(1)"x="';
      const result = plainTextToSafeHtml(payload);
      // The anchor tag must not contain any unescaped attribute beyond href/target/rel.
      expect(result).not.toMatch(/<a [^>]*onmouseover/i);
      expect(result).not.toMatch(/<a [^>]*style=/i);
      // Quotes from the payload must be entity-encoded wherever they land.
      expect(result).toContain('&quot;');
    });

    it('prevents attribute breakout via style injection', () => {
      const payload = 'http://evil.tld/"style="background:red"x="';
      const result = plainTextToSafeHtml(payload);
      expect(result).not.toMatch(/href="[^"]*"[^>]*style=/);
    });

    it('terminates URL at quote, keeping rest as escaped text', () => {
      const result = plainTextToSafeHtml('http://evil.tld/"injected');
      expect(result).toContain('<a href="http://evil.tld/"');
      expect(result).toContain('&quot;injected');
    });

    it('applies linkClass when provided and escapes it', () => {
      const result = plainTextToSafeHtml('http://x.com', 'text-primary hover:underline');
      expect(result).toContain('class="text-primary hover:underline"');
    });

    it('does not linkify non-http schemes', () => {
      const result = plainTextToSafeHtml('try javascript:alert(1) or file:///etc/passwd');
      expect(result).not.toContain('<a ');
      expect(result).toContain('javascript:alert(1)');
    });
  });
});
