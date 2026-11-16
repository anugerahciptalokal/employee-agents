import http from 'http';
import https from 'https';
import { URL } from 'url';

export interface OpenGraphMetadata {
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
}

export interface ScrapeResult {
  url: string;
  title: string;
  text: string;
  openGraph?: OpenGraphMetadata;
  timestamp: number;
}

/**
 * Validates and normalizes target URL for autonomous web scraping.
 * Enforces strict protocol boundary: ONLY http: and https: are allowed.
 */
export function validateScrapeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Invalid URL provided');
  }

  const trimmed = rawUrl.trim();
  const lower = trimmed.toLowerCase();

  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:')
  ) {
    throw new Error(`Forbidden URL protocol for scraping: ${trimmed}`);
  }

  let formatted = trimmed;
  if (!/^https?:\/\//i.test(formatted)) {
    formatted = `https://${formatted}`;
  }

  const parsed = new URL(formatted);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  return parsed.toString();
}

/**
 * Extracts readable clean text, title, and body from raw HTML.
 * Strips script tags, style blocks, inline comments, and collapses excess whitespace.
 */
export function extractReadableTextFromHtml(html: string): { title: string; text: string } {
  if (!html || typeof html !== 'string') {
    return { title: 'Untitled Web Document', text: '' };
  }

  // 1. Extract <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch && titleMatch[1]
    ? titleMatch[1].replace(/\s+/g, ' ').trim()
    : 'Untitled Web Document';

  // 2. Remove non-content tags: scripts, styles, noscript, iframes, comments
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // 3. Convert basic formatting elements to linebreaks
  cleaned = cleaned
    .replace(/<\/(p|div|h[1-6]|li|tr|article|section|header|footer)>/gi, '\n')
    .replace(/<br\s*[\/]?>/gi, '\n');

  // 4. Strip all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  // 5. Decode basic HTML entities
  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // 6. Clean up line breaks and excessive whitespace
  const lines = cleaned
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);

  const text = lines.join('\n\n');

  return {
    title,
    text
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Extracts OpenGraph & standard description metadata from HTML `<meta>` tags.
 * Useful for JS-rendered / social links where `<body>` may be empty on static HTTP fetch.
 */
export function extractOpenGraphMetadata(html: string): OpenGraphMetadata {
  if (!html || typeof html !== 'string') return {};

  const readMeta = (attrName: string, attrValue: string): string | undefined => {
    const forward = new RegExp(
      `<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      'i'
    );
    const reverse = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+${attrName}=["']${attrValue}["'][^>]*>`,
      'i'
    );
    const match = html.match(forward) || html.match(reverse);
    const raw = match?.[1]?.trim();
    return raw ? decodeHtmlEntities(raw) : undefined;
  };

  return {
    title: readMeta('property', 'og:title') || readMeta('name', 'twitter:title'),
    description:
      readMeta('property', 'og:description') ||
      readMeta('name', 'twitter:description') ||
      readMeta('name', 'description'),
    siteName: readMeta('property', 'og:site_name'),
    image: readMeta('property', 'og:image') || readMeta('name', 'twitter:image')
  };
}

/**
 * Checks whether a hostname resolves to loopback, link-local, or private RFC1918 ranges (SSRF guard).
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = (hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) return false;

  const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Extracts unique `http://` and `https://` URLs from free-form message text.
 */
export function extractUrlsFromText(text: string, maxUrls = 3): string[] {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/gi) || [];
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?)]+$/, '');
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      unique.push(cleaned);
      if (unique.length >= maxUrls) break;
    }
  }
  return unique;
}

/**
 * Formats fetched URL results (OpenGraph + readable text) into a bounded context block for LLM turns.
 */
export function buildUrlContextBlock(results: ScrapeResult[], maxChars = 6_000): string {
  if (!results || results.length === 0) return '';
  const blocks: string[] = [];

  for (const res of results) {
    const lines: string[] = [`URL: ${res.url}`];
    if (res.openGraph?.siteName) lines.push(`Site: ${res.openGraph.siteName}`);
    if (res.openGraph?.title || res.title) {
      lines.push(`Title: ${res.openGraph?.title || res.title}`);
    }
    if (res.openGraph?.description) {
      lines.push(`Description: ${res.openGraph.description}`);
    }
    if (res.openGraph?.image) {
      lines.push(`Preview Image: ${res.openGraph.image}`);
    }
    if (res.text) {
      const snippet = res.text.length > 1_800 ? `${res.text.slice(0, 1_800)}...` : res.text;
      lines.push(`Page Content:\n${snippet}`);
    }
    blocks.push(lines.join('\n'));
  }

  const combined = `[URL Context]\n${blocks.join('\n\n---\n\n')}`;
  return combined.length > maxChars ? `${combined.slice(0, maxChars)}...` : combined;
}

/**
 * Autonomous Web Fetcher & Scraper.
 * Fetches remote HTML with timeout and user-agent, then parses readable content.
 */
export async function fetchAndScrapeUrl(targetUrl: string, timeoutMs = 8000): Promise<ScrapeResult> {
  const safeUrl = validateScrapeUrl(targetUrl);
  const parsed = new URL(safeUrl);
  const client = parsed.protocol === 'https:' ? https : http;

  const html = await new Promise<string>((resolve, reject) => {
    const req = client.get(
      safeUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OpenEmployee/1.0.0 Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: timeoutMs
      },
      (res) => {
        // Follow redirects up to 1 hop
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          try {
            const redirectUrl = new URL(res.headers.location, safeUrl).toString();
            fetchAndScrapeUrl(redirectUrl, timeoutMs).then(
              (r) => resolve(r.text),
              reject
            );
            return;
          } catch (_e) {
            reject(new Error(`Failed parsing redirect location: ${res.headers.location}`));
            return;
          }
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP error ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
          // Prevent downloading excessively huge responses (max 5MB)
          if (body.length > 5 * 1024 * 1024) {
            req.destroy();
            resolve(body);
          }
        });
        res.on('end', () => resolve(body));
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => reject(err));
  });

  const parsedDoc = extractReadableTextFromHtml(html);
  const openGraph = extractOpenGraphMetadata(html);

  return {
    url: safeUrl,
    title: openGraph.title || parsedDoc.title,
    text: parsedDoc.text,
    openGraph,
    timestamp: Date.now()
  };
}

/**
 * Safely fetches public URLs found in a message (skipping private/loopback SSRF targets).
 */
export async function fetchPublicUrlContexts(urls: string[], timeoutMs = 4000): Promise<ScrapeResult[]> {
  const results: ScrapeResult[] = [];
  for (const rawUrl of urls) {
    try {
      const safe = validateScrapeUrl(rawUrl);
      const parsed = new URL(safe);
      if (isPrivateOrLoopbackHost(parsed.hostname)) continue;
      const scraped = await fetchAndScrapeUrl(safe, timeoutMs);
      results.push(scraped);
    } catch {
      // Best-effort: skip unreachable or blocked URLs without failing the chat turn
    }
  }
  return results;
}

