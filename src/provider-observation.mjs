export function classifyProviderSaturation(text) {
  if (typeof text !== 'string' || !text) return null;
  if (/401|unauthorized|invalid\.api\.key|invalid api key/i.test(text)) return null;
  if (/403|forbidden/i.test(text)) return null;
  if (/selected model is at capacity/i.test(text)) return 'provider_saturated';
  if (/429|rate.?limit|resource-exhausted/i.test(text)) return 'provider_rate_limited';
  if (/proxy_error/i.test(text) || (/502/.test(text) && /proxy/i.test(text))) return 'provider_proxy_unavailable';
  return null;
}

export function providerObservationFromText(text) {
  const code = classifyProviderSaturation(text);
  return code ? { code } : null;
}
