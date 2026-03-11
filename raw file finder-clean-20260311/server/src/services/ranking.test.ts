import assert from "node:assert/strict";
import test from "node:test";
import { computeRankingBoost, parseRankingTerms } from "./ranking.js";

test("parseRankingTerms supports weighted and unweighted entries", () => {
  const result = parseRankingTerms("promo,2\ninterview\nsoundbite|3");
  assert.deepEqual(result, [
    { term: "promo", weight: 2 },
    { term: "interview", weight: 1 },
    { term: "soundbite", weight: 3 },
  ]);
});

test("computeRankingBoost sums matching terms", () => {
  const terms = parseRankingTerms("promo,2\ninterview");
  assert.equal(computeRankingBoost("Promo interview select", terms), 3);
  assert.equal(computeRankingBoost("B-roll only", terms), 0);
});
