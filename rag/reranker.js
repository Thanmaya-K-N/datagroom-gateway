/**
 * Heuristic Re-ranker for RAG Retrieval
 * 
 * Implements deterministic re-ranking of vector search results using:
 * 1. Vector similarity score (from MongoDB Atlas)
 * 2. Keyword overlap between query and chunk text
 * 3. Metadata confidence score
 * 4. Document recency
 * 
 * Flow:
 * - Retrieve broad candidate set (numCandidates: 100-200)
 * - Get initial top ~30 results from vector search
 * - Apply heuristic scoring formula
 * - Sort by final_score
 * - Select top 5-8 chunks
 * 
 * NO LLM-based re-ranking at this stage (future enhancement).
 */

'use strict';

const logger = require('../logger');

// Scoring weights (sum to 1.0 for normalized final score)
const WEIGHTS = {
  vectorSimilarity: 0.50,  // 50% - Primary signal
  keywordOverlap: 0.25,    // 25% - Lexical match
  confidence: 0.15,        // 15% - Metadata quality
  recency: 0.10            // 10% - Temporal relevance
};

/**
 * Calculate keyword overlap score between query and text
 * Uses Jaccard similarity on tokenized words (case-insensitive)
 * 
 * @param {string} query - User query
 * @param {string} text - Document text
 * @returns {number} - Score 0-1
 */
function calculateKeywordOverlap(query, text) {
  if (!query || !text) return 0;

  // Tokenize: lowercase, remove punctuation, split on whitespace
  const tokenize = (str) => {
    return str
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 2);  // Filter short tokens
  };

  const queryTokens = new Set(tokenize(query));
  const textTokens = new Set(tokenize(text));

  if (queryTokens.size === 0 || textTokens.size === 0) return 0;

  // Jaccard similarity: |intersection| / |union|
  const intersection = new Set([...queryTokens].filter(t => textTokens.has(t)));
  const union = new Set([...queryTokens, ...textTokens]);

  const jaccardScore = intersection.size / union.size;

  // Also compute term frequency bonus for query terms in text
  const queryTermsInText = [...queryTokens].filter(t => textTokens.has(t)).length;
  const termCoverage = queryTermsInText / queryTokens.size;

  // Combine Jaccard and term coverage (weighted average)
  return 0.6 * jaccardScore + 0.4 * termCoverage;
}

/**
 * Calculate recency score based on document age
 * Newer documents get higher scores
 * 
 * @param {Date|null} createdAt - Document creation timestamp
 * @param {Date} now - Current timestamp
 * @returns {number} - Score 0-1
 */
function calculateRecencyScore(createdAt, now) {
  if (!createdAt) return 0.5;  // Neutral score for missing dates

  const ageMs = now - createdAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // Exponential decay: score decreases as age increases
  // Half-life: 90 days (score = 0.5 at 90 days old)
  const halfLifeDays = 90;
  const decayFactor = Math.exp(-0.693 * ageDays / halfLifeDays);

  return Math.max(0, Math.min(1, decayFactor));
}

/**
 * Compute final heuristic score for a single document
 * 
 * @param {Object} doc - Document with { score, text, metadata }
 * @param {string} query - User query
 * @param {Date} now - Current timestamp
 * @returns {Object} - Document with added final_score and scoring breakdown
 */
function scoreDocument(doc, query, now) {
  // 1. Vector similarity (from MongoDB Atlas, already normalized 0-1)
  const vectorScore = doc.score || 0;

  // 2. Keyword overlap
  const keywordScore = calculateKeywordOverlap(query, doc.text);

  // 3. Confidence from metadata
  const confidenceScore = doc.metadata && typeof doc.metadata.confidence === 'number'
    ? doc.metadata.confidence
    : 0.8;  // Default confidence

  // 4. Recency
  const createdAt = doc.metadata && doc.metadata.created_at
    ? new Date(doc.metadata.created_at)
    : null;
  const recencyScore = calculateRecencyScore(createdAt, now);

  // Compute weighted final score
  const finalScore = 
    WEIGHTS.vectorSimilarity * vectorScore +
    WEIGHTS.keywordOverlap * keywordScore +
    WEIGHTS.confidence * confidenceScore +
    WEIGHTS.recency * recencyScore;

  return {
    ...doc,
    final_score: finalScore,
    scoring_breakdown: {
      vector_similarity: vectorScore,
      keyword_overlap: keywordScore,
      confidence: confidenceScore,
      recency: recencyScore
    }
  };
}

/**
 * Re-rank retrieved documents using heuristic scoring
 * 
 * @param {Array} documents - Initial vector search results
 *   Each doc: { id, text, score, metadata }
 * @param {string} query - User query
 * @param {number} topK - Number of documents to return after re-ranking (default: 8)
 * @returns {Array} - Top-K re-ranked documents with final_score
 */
function rerank(documents, query, topK) {
  if (!Array.isArray(documents) || documents.length === 0) {
    logger.warn('[Reranker] No documents to re-rank');
    return [];
  }

  const k = topK || 8;
  const now = new Date();

  logger.info('[Reranker] Re-ranking ' + documents.length + ' documents, selecting top ' + k);

  // Score each document
  const scored = documents.map(doc => scoreDocument(doc, query, now));

  // Sort by final_score (descending)
  scored.sort((a, b) => b.final_score - a.final_score);

  // Select top K
  const topK_results = scored.slice(0, k);

  // Log re-ranking summary
  logger.info('[Reranker] Re-ranking complete:');
  logger.info('[Reranker]   - Input documents: ' + documents.length);
  logger.info('[Reranker]   - Output documents: ' + topK_results.length);
  logger.info('[Reranker]   - Score range: ' + 
    (topK_results.length > 0 
      ? topK_results[topK_results.length - 1].final_score.toFixed(3) + ' - ' + topK_results[0].final_score.toFixed(3)
      : 'N/A'));

  // Log top document IDs for observability
  const topIds = topK_results.slice(0, 3).map(d => d.id);
  logger.info('[Reranker]   - Top 3 IDs: ' + topIds.join(', '));

  return topK_results;
}

/**
 * Configuration helper: get recommended numCandidates and initial limit
 * based on desired final topK
 * 
 * @param {number} finalTopK - Desired final result count (default: 8)
 * @returns {Object} - { numCandidates, initialLimit }
 */
function getRetrievalConfig(finalTopK) {
  const k = finalTopK || 8;

  // Heuristic: retrieve ~4x candidates for re-ranking
  // Bounded between 50-200 to prevent excessive computation
  const numCandidates = Math.min(200, Math.max(50, k * 12));
  const initialLimit = Math.min(30, k * 4);

  return {
    numCandidates,
    initialLimit
  };
}

module.exports = {
  rerank,
  calculateKeywordOverlap,
  calculateRecencyScore,
  getRetrievalConfig,
  WEIGHTS
};
