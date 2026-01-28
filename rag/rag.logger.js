/**
 * Structured Logging Module for RAG Pipeline
 * 
 * Provides comprehensive observability with:
 * - Request ID tracking
 * - Stage-by-stage latency measurement
 * - Router decisions and confidence
 * - Retrieved document IDs
 * - Metadata filters applied
 * - Model usage tracking
 * 
 * Format: Grouped logs per request for readability
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');

class RAGLogger {
  constructor(requestId) {
    this.requestId = requestId || uuidv4();
    this.startTime = Date.now();
    this.stages = {};
    this.metadata = {
      router: null,
      filters: null,
      retrieval: null,
      reranking: null,
      generation: null,
      models: {}
    };
  }

  /**
   * Start timing a stage
   * @param {string} stageName - Name of the stage
   */
  startStage(stageName) {
    this.stages[stageName] = {
      start: Date.now(),
      end: null,
      duration: null
    };
  }

  /**
   * End timing a stage
   * @param {string} stageName - Name of the stage
   */
  endStage(stageName) {
    if (this.stages[stageName]) {
      this.stages[stageName].end = Date.now();
      this.stages[stageName].duration = this.stages[stageName].end - this.stages[stageName].start;
    }
  }

  /**
   * Log router decision
   * @param {Object} decision - {route, confidence, reason}
   * @param {string} model - Model used for routing
   */
  logRouter(decision, model) {
    this.metadata.router = {
      route: decision.route,
      confidence: decision.confidence,
      reason: decision.reason,
      model: model
    };
    this.metadata.models.router = model;
  }

  /**
   * Log extracted metadata filters
   * @param {Object} filters - Metadata filters applied
   */
  logFilters(filters) {
    this.metadata.filters = filters || {};
  }

  /**
   * Log retrieval results
   * @param {number} numCandidates - Number of candidates retrieved
   * @param {Array} documentIds - Retrieved document IDs
   * @param {string} model - Embedding model used
   */
  logRetrieval(numCandidates, documentIds, model) {
    this.metadata.retrieval = {
      numCandidates: numCandidates,
      documentIds: documentIds || [],
      documentCount: documentIds ? documentIds.length : 0,
      model: model
    };
    this.metadata.models.embedding = model;
  }

  /**
   * Log re-ranking results
   * @param {Array} originalIds - Document IDs before re-ranking
   * @param {Array} rerankedIds - Document IDs after re-ranking
   * @param {number} finalCount - Final count of selected documents
   */
  logReranking(originalIds, rerankedIds, finalCount) {
    this.metadata.reranking = {
      originalIds: originalIds || [],
      rerankedIds: rerankedIds || [],
      originalCount: originalIds ? originalIds.length : 0,
      finalCount: finalCount || 0
    };
  }

  /**
   * Log generation details
   * @param {number} contextChunkCount - Number of context chunks used
   * @param {string} model - LLM model used for generation
   */
  logGeneration(contextChunkCount, model) {
    this.metadata.generation = {
      contextChunkCount: contextChunkCount,
      model: model
    };
    this.metadata.models.generation = model;
  }

  /**
   * Get total request latency
   * @returns {number} - Latency in milliseconds
   */
  getTotalLatency() {
    return Date.now() - this.startTime;
  }

  /**
   * Get stage latencies as object
   * @returns {Object} - Map of stage names to durations
   */
  getStageLatencies() {
    var latencies = {};
    Object.keys(this.stages).forEach((stage) => {
      latencies[stage] = this.stages[stage].duration || 0;
    });
    return latencies;
  }

  /**
   * Print comprehensive log summary
   * Grouped and readable format for production debugging
   */
  logSummary() {
    var totalLatency = this.getTotalLatency();
    var stageLatencies = this.getStageLatencies();

    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('RAG REQUEST SUMMARY');
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info('Request ID: ' + this.requestId);
    logger.info('Total Latency: ' + totalLatency + 'ms');
    logger.info('───────────────────────────────────────────────────────────────');

    // Router decision
    if (this.metadata.router) {
      logger.info('ROUTER DECISION:');
      logger.info('  Route: ' + this.metadata.router.route);
      logger.info('  Confidence: ' + this.metadata.router.confidence.toFixed(2));
      logger.info('  Reason: ' + this.metadata.router.reason);
      logger.info('  Model: ' + this.metadata.router.model);
      logger.info('───────────────────────────────────────────────────────────────');
    }

    // Metadata filters
    if (this.metadata.filters && Object.keys(this.metadata.filters).length > 0) {
      logger.info('METADATA FILTERS:');
      Object.keys(this.metadata.filters).forEach((key) => {
        logger.info('  ' + key + ': ' + this.metadata.filters[key]);
      });
      logger.info('───────────────────────────────────────────────────────────────');
    }

    // Retrieval
    if (this.metadata.retrieval) {
      logger.info('RETRIEVAL:');
      logger.info('  Candidates: ' + this.metadata.retrieval.numCandidates);
      logger.info('  Retrieved: ' + this.metadata.retrieval.documentCount);
      logger.info('  Document IDs: ' + this.metadata.retrieval.documentIds.slice(0, 5).join(', ') + 
                  (this.metadata.retrieval.documentIds.length > 5 ? '...' : ''));
      logger.info('  Model: ' + this.metadata.retrieval.model);
      logger.info('───────────────────────────────────────────────────────────────');
    }

    // Re-ranking
    if (this.metadata.reranking) {
      logger.info('RE-RANKING:');
      logger.info('  Before: ' + this.metadata.reranking.originalCount + ' documents');
      logger.info('  After: ' + this.metadata.reranking.finalCount + ' documents');
      logger.info('  Top IDs: ' + this.metadata.reranking.rerankedIds.slice(0, 3).join(', '));
      logger.info('───────────────────────────────────────────────────────────────');
    }

    // Generation
    if (this.metadata.generation) {
      logger.info('GENERATION:');
      logger.info('  Context Chunks: ' + this.metadata.generation.contextChunkCount);
      logger.info('  Model: ' + this.metadata.generation.model);
      logger.info('───────────────────────────────────────────────────────────────');
    }

    // Stage latencies
    logger.info('STAGE LATENCIES:');
    Object.keys(stageLatencies).forEach((stage) => {
      var duration = stageLatencies[stage];
      var percentage = totalLatency > 0 ? ((duration / totalLatency) * 100).toFixed(1) : 0;
      logger.info('  ' + stage + ': ' + duration + 'ms (' + percentage + '%)');
    });
    logger.info('───────────────────────────────────────────────────────────────');

    // Models used
    logger.info('MODELS USED:');
    Object.keys(this.metadata.models).forEach((role) => {
      logger.info('  ' + role + ': ' + this.metadata.models[role]);
    });
    logger.info('═══════════════════════════════════════════════════════════════');
  }

  /**
   * Export structured log data as JSON (for external logging systems)
   * @returns {Object} - Complete log data
   */
  toJSON() {
    return {
      request_id: this.requestId,
      total_latency_ms: this.getTotalLatency(),
      stage_latencies: this.getStageLatencies(),
      router: this.metadata.router,
      filters: this.metadata.filters,
      retrieval: this.metadata.retrieval,
      reranking: this.metadata.reranking,
      generation: this.metadata.generation,
      models: this.metadata.models,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Create a new RAG logger instance
 * @param {string} requestId - Optional request ID (auto-generated if not provided)
 * @returns {RAGLogger}
 */
function createLogger(requestId) {
  return new RAGLogger(requestId);
}

module.exports = {
  createLogger,
  RAGLogger
};
