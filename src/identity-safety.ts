/** Finite conservative boundary, not an adult authorization/classification system. */
export function textVariants(text: string): string[] {
  let value = text.normalize("NFKC").replace(/[\p{Cf}]/gu, "");
  value = value.replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const variants = new Set([value]);
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(value);
      if (next === value) break;
      value = next;
      variants.add(value);
    } catch { break; }
  }
  for (const candidate of [...variants]) {
    for (const token of candidate.match(/[A-Za-z0-9+/_-]{8,}={0,2}|[0-9a-fA-F]{8,}/g) ?? []) {
      for (const encoding of ["base64url", "hex"] as const) {
        const decoded = Buffer.from(token, encoding).toString("utf8");
        if (decoded && !decoded.includes("\uFFFD")) {
          variants.add(decoded);
          try { variants.add(decodeURIComponent(decoded)); } catch { /* Keep the undecoded view. */ }
        }
      }
    }
  }
  return [...variants].map(item => item.normalize("NFKC").replace(/[\p{Cf}]/gu, "")
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))));
}

export function suspectedAdult(text: string): boolean {
  return textVariants(text).some(value => /色情|性爱|做爱|性交|口交|肛交|自慰|手淫|裸照|裸体|性器|阴茎|阴道|乳交|调教|淫荡|发情|成人内容|成人模式|\b(?:nsfw|porn|hentai|erotic|blowjob|nudes?|sexting)\b/i.test(value));
}
