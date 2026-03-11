import type { RankingTerm } from "../models.js";

export function parseRankingTerms(content: string): RankingTerm[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [termPart, weightPart] = line.split(/[,\t|]/, 2).map((part) => part?.trim() ?? "");
      const weight = Number.parseFloat(weightPart);
      return {
        term: termPart,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      };
    })
    .filter((entry) => entry.term.length > 0);
}

export function computeRankingBoost(text: string, terms: RankingTerm[]): number {
  const normalized = text.toLowerCase();
  return terms.reduce((sum, term) => {
    return normalized.includes(term.term.toLowerCase()) ? sum + term.weight : sum;
  }, 0);
}
