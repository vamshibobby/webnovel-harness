import { OpenRouterError, appAttribution } from './openrouter.js';

/**
 * OpenRouter's image-generations endpoint — a separate surface from chat
 * completions with its own model catalog (FLUX, Grok Imagine and friends live
 * here, not in /models). One shot, no streaming, base64 back.

 */
export interface GeneratedImage {
  /** Raw image bytes. */
  data: Buffer;
  contentType: string;
  cost: number;
}

export async function generateImage(opts: {
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
}): Promise<GeneratedImage> {
  const res = await fetch('https://openrouter.ai/api/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      ...appAttribution(),
    },
    body: JSON.stringify({ model: opts.model, prompt: opts.prompt, n: 1, size: opts.size }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    data?: Array<{ b64_json?: string; url?: string }>;
    usage?: { cost?: number };
    error?: { message?: string };
  };

  if (!res.ok || body.error) {
    throw new OpenRouterError(
      `Image generation failed: ${body.error?.message ?? `HTTP ${res.status}`}`,
      res.status === 401 || res.status === 402 ? res.status : 502
    );
  }
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new OpenRouterError('Image generation returned no image.', 502);
  return {
    data: Buffer.from(b64, 'base64'),
    contentType: 'image/png',
    cost: body.usage?.cost ?? 0,
  };
}
