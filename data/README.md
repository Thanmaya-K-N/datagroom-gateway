# RAG Embeddings Storage

This directory stores the vector embeddings for each dataset.

The `rag-embeddings.json` file will be automatically created when you initialize RAG for the first time.

## File Structure

```json
{
  "datasetName": {
    "datasetId": "datasetName",
    "chunks": [
      {
        "id": "uuid",
        "text": "chunk content...",
        "embedding": [0.1, 0.2, 0.3, ...]
      }
    ],
    "createdAt": "2026-01-02T..."
  }
}
```

## Do Not Manually Edit

This file is managed automatically by the RAG service. Manual edits may corrupt the embeddings.

## Backup

Consider backing up this file periodically if you want to preserve embeddings across system restarts or migrations.
