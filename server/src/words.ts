// Word splitting shared by search (query terms) and store (keyword
// de-duplication). No imports, so store.ts and search.ts can both use it.

export const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "what", "how", "are", "was",
  "해줘", "해주세요", "있어", "없어", "그리고", "그런데", "근데", "이거", "저거", "그거", "어떻게", "뭐야", "에서",
]);

/** Lowercased words as the query splits them: letters, digits and _ . - /, edge punctuation trimmed. */
export function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.\-/]+/u)
    .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ""))
    .filter(Boolean);
}

/** The words of `text` a search for it would use (same split, length and stopword rules as extractTerms). */
export function searchWords(text: string): string[] {
  return [...new Set(splitWords(text).filter((w) => w.length >= 2 && !STOPWORDS.has(w)))];
}

/**
 * A search keyword is redundant when it has search words and every one of
 * them is already a whole word of the memory's title/body ("k8s" vs "k8s/").
 * Words only sharing a prefix differ ("postgres" vs "postgresql"), so such
 * keywords stay; a keyword with no search words (stopwords, one letter) stays.
 */
export function keywordRedundant(keyword: string, textWords: Set<string>): boolean {
  const words = searchWords(keyword);
  return words.length > 0 && words.every((w) => textWords.has(w));
}

/** Word set of a memory's title + body, for keywordRedundant. */
export const textWordSet = (...texts: string[]) => new Set(texts.flatMap(splitWords));
