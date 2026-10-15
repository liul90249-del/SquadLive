const transientStatuses = new Set([500, 502, 503, 504]);

// Keep both attempts within the iOS client's request budget.
export async function requestDeepSeekCompletion({ apiKey, payload, fetchImpl = fetch,
  timeoutMs = 8000, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!apiKey?.trim()) return { reason: 'missing_key', providerStatus: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.trim()}` },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        await response.text();
        if (attempt === 0 && transientStatuses.has(response.status)) {
          await wait(250);
          continue;
        }
        return { reason: 'provider_error', providerStatus: response.status };
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content) return { reason: 'empty_response', providerStatus: response.status };
      return { content, reason: null, providerStatus: response.status };
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (attempt === 0) {
        await wait(250);
        continue;
      }
      return { reason: timedOut ? 'timeout' : 'network_error', providerStatus: null };
    }
  }
}
