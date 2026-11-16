import type { ChatMessage } from '../core/agents/ai-gateway-client';
import {
  extractUrlsFromText,
  fetchPublicUrlContexts,
  buildUrlContextBlock,
  isPrivateOrLoopbackHost,
  validateScrapeUrl,
  type ScrapeResult
} from '../core/browser/scraper';
import {
  HeadlessChromeRemoteManager,
  captureUrlSnapshotWithChrome,
  resolveBrowserProfileDir
} from '../core/browser/headless-chrome-remote';

export interface UrlContextEnrichmentInput {
  messages: ChatMessage[];
  imageUrl?: string;
  conversationId?: string;
  conversationType?: 'agent' | 'channel';
  dataRoot?: string;
}

export interface UrlContextEnrichmentResult {
  messages: ChatMessage[];
  imageUrl?: string;
  urlContextBlock: string;
}

/**
 * Enriches the latest user message in a chat turn with OpenGraph + readable web content
 * for any public URLs present, falling back to Headless Chrome CDP + screenshot
 * when static HTTP fetch returns minimal/JS-rendered HTML (e.g. Instagram, X, SPAs).
 */
export async function enrichMessagesWithUrlContext(
  input: UrlContextEnrichmentInput
): Promise<UrlContextEnrichmentResult> {
  const messages = input.messages.map((m) => ({ ...m }));
  let imageUrl = input.imageUrl;

  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
  if (lastUserIdx < 0) {
    return { messages, imageUrl, urlContextBlock: '' };
  }

  const lastUserMsg = messages[lastUserIdx];
  const userText =
    typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg.content)
      ? (lastUserMsg.content as Array<{ type?: string; text?: string }>)
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n')
      : '';

  const detectedUrls = extractUrlsFromText(userText);
  if (detectedUrls.length === 0) {
    return { messages, imageUrl, urlContextBlock: '' };
  }

  const urlResults = await fetchPublicUrlContexts(detectedUrls);
  const enrichedResults: ScrapeResult[] = [];
  const profileDir = resolveBrowserProfileDir(
    input.conversationId,
    input.conversationType,
    input.dataRoot
  );

  for (const rawUrl of detectedUrls) {
    const existing =
      urlResults.find((r) => r.url === rawUrl) ||
      urlResults.find((r) => r.url.startsWith(rawUrl));
    const needsBrowserFallback =
      !existing || (!existing.openGraph?.description && existing.text.length < 120);

    let candidateMediaUrls: string[] = [];
    if (existing?.openGraph?.image) {
      candidateMediaUrls.push(existing.openGraph.image);
    }

    if (needsBrowserFallback) {
      try {
        const safe = validateScrapeUrl(rawUrl);
        if (!isPrivateOrLoopbackHost(new URL(safe).hostname)) {
          const liveManager = HeadlessChromeRemoteManager.getInstance();
          const snap =
            (await liveManager.navigateAndCapture(safe, profileDir)) ||
            (await captureUrlSnapshotWithChrome(safe, profileDir));
          if (snap) {
            if (snap.mediaUrls && snap.mediaUrls.length > 0) {
              candidateMediaUrls = snap.mediaUrls;
            } else if (snap.ogImage) {
              candidateMediaUrls = [snap.ogImage];
            }

            if (!imageUrl && snap.screenshotDataUrl) {
              imageUrl = snap.screenshotDataUrl;
            }

            enrichedResults.push({
              url: safe,
              title: snap.ogTitle || snap.title,
              text: snap.text || existing?.text || '',
              openGraph: {
                ...existing?.openGraph,
                title: snap.ogTitle || existing?.openGraph?.title,
                description: snap.ogDescription || existing?.openGraph?.description,
                image: snap.ogImage || candidateMediaUrls[0] || existing?.openGraph?.image
              },
              timestamp: Date.now()
            });
            continue;
          }
        }
      } catch {
        // Best-effort browser fallback
      }
    }

    if (existing) {
      enrichedResults.push(existing);
    }
  }

  const urlContextBlock = buildUrlContextBlock(enrichedResults);

  if (urlContextBlock) {
    if (typeof lastUserMsg.content === 'string') {
      messages[lastUserIdx] = {
        ...lastUserMsg,
        content: `${lastUserMsg.content}\n\n${urlContextBlock}`
      };
    } else if (Array.isArray(lastUserMsg.content)) {
      const clonedParts = (lastUserMsg.content as Array<{ type: string; text?: string }>).map(
        (p) => ({ ...p })
      );
      const firstText = clonedParts.find((p) => p.type === 'text');
      if (firstText) {
        firstText.text = `${firstText.text || ''}\n\n${urlContextBlock}`;
      }
      messages[lastUserIdx] = { ...lastUserMsg, content: clonedParts as unknown as string };
    }
  }

  return { messages, imageUrl, urlContextBlock };
}
