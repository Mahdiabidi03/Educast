"""
services/vector_store.py
========================
Pinecone integration for EduCast AI Service.

Responsibilities
----------------
- Initialise the Pinecone client and ensure the index exists with the
  correct dimension (384).
- Upsert embedding vectors together with their enriched metadata.
- Provide a `get_neighboring_chunks()` utility for future RAG context
  window expansion (not yet called automatically).

Chunk metadata stored per vector
---------------------------------
{
    "document_id":   str,
    "page_number":   int,
    "section":       str | None,
    "element_type":  "text" | "table" | "heading",
    "chunk_index":   int,
    "text":          str,   # full chunk text, stored for retrieval convenience
}
"""

import os
import logging
from typing import List, Dict, Any

from pinecone import Pinecone, ServerlessSpec

log = logging.getLogger(__name__)

_EMBEDDING_DIM = 384  # all-MiniLM-L6-v2


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------

def init_pinecone() -> Pinecone:
    """Initialise and return the Pinecone client."""
    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        raise ValueError("PINECONE_API_KEY environment variable is not set")
    return Pinecone(api_key=api_key)


def ensure_index_exists() -> None:
    """
    Check that the Pinecone index exists with dimension 384.
    Creates it (serverless, AWS us-east-1) if it does not exist yet.
    Raises ValueError if the index exists with the wrong dimension.
    """
    pc = init_pinecone()
    index_name = os.getenv("PINECONE_INDEX_NAME", "educast")

    if not pc.has_index(index_name):
        log.info("Index '%s' does not exist — creating it now.", index_name)
        pc.create_index(
            name=index_name,
            dimension=_EMBEDDING_DIM,
            metric="cosine",
            spec=ServerlessSpec(cloud="aws", region="us-east-1"),
        )
        log.info("Index '%s' created successfully (dimension %d).", index_name, _EMBEDDING_DIM)
    else:
        index_info = pc.describe_index(index_name)
        if index_info.dimension != _EMBEDDING_DIM:
            raise ValueError(
                f"Pinecone index '{index_name}' exists but has dimension "
                f"{index_info.dimension} instead of {_EMBEDDING_DIM}. "
                f"Delete the index from the Pinecone dashboard and restart."
            )
        log.info("Index '%s' exists with correct dimension %d.", index_name, _EMBEDDING_DIM)


def get_index():
    """Return the Pinecone Index object (assumes ensure_index_exists() was called)."""
    pc = init_pinecone()
    index_name = os.getenv("PINECONE_INDEX_NAME", "educast")
    return pc.Index(index_name)


# ---------------------------------------------------------------------------
# Metadata helpers
# ---------------------------------------------------------------------------

def _sanitize_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    """
    Pinecone rejects metadata values that are None / null (raises a 400-level
    error with message "Metadata value must be a string, number, boolean or
    list of strings").

    This helper replaces every None with a safe default so upserts never fail
    silently on null fields.  It also coerces page_number to int so it stays
    filterable.
    """
    cleaned: Dict[str, Any] = {}
    for key, value in metadata.items():
        if value is None:
            # Choose a sensible empty default by field name
            if key == "page_number":
                cleaned[key] = 0
            else:
                cleaned[key] = ""  # empty string for section, element_type, etc.
        else:
            cleaned[key] = value
    return cleaned


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------

def store_chunks(chunks: List[Dict[str, Any]]) -> None:
    """
    Upsert chunks (with their embeddings and enriched metadata) into Pinecone.

    Each chunk must have:
        - "id"        : str — unique vector ID
        - "embedding" : List[float] — 384-dimensional vector
        - "metadata"  : Dict — arbitrary metadata stored alongside the vector

    The metadata dict is forwarded verbatim to Pinecone, so all enriched
    fields (document_id, page_number, section, element_type, chunk_index)
    are stored automatically.
    """
    if not chunks:
        return

    index = get_index()

    vectors = [
        {
            "id": chunk["id"],
            "values": chunk["embedding"],
            # Sanitize metadata: replace None values before sending to Pinecone
            "metadata": _sanitize_metadata(chunk["metadata"]),
        }
        for chunk in chunks
    ]

    # Upsert in batches to stay within Pinecone’s payload size limit
    batch_size = 100
    failed_batches: list = []
    for i in range(0, len(vectors), batch_size):
        batch = vectors[i : i + batch_size]
        try:
            index.upsert(vectors=batch)
            log.debug("Upserted batch %d–%d.", i, i + len(batch) - 1)
        except Exception as upsert_err:
            log.error(
                "Pinecone upsert FAILED for batch %d–%d: %s",
                i, i + len(batch) - 1, upsert_err,
            )
            failed_batches.append((i, i + len(batch) - 1, str(upsert_err)))

    if failed_batches:
        error_summary = "; ".join(
            f"batch {s}–{e}: {err}" for s, e, err in failed_batches
        )
        raise RuntimeError(
            f"Pinecone upsert failed for {len(failed_batches)} batch(es): {error_summary}"
        )

    log.info("Stored %d vectors in Pinecone.", len(vectors))



# ---------------------------------------------------------------------------
# Read — neighbor-context utility (used by future RAG context expansion)
# ---------------------------------------------------------------------------

def get_neighboring_chunks(
    document_id: str,
    chunk_index: int,
    window: int = 1,
) -> List[Dict[str, Any]]:
    """
    Retrieve the chunks immediately before and after a given chunk in the
    same document using direct ID-based fetching.

    This function is **not yet called automatically** — it is provided as a
    building block for future RAG context-window expansion.

    Why fetch() instead of query()
    --------------------------------
    Using a zero-vector with cosine metric is unsafe (zero-norm vector yields
    undefined cosine similarity).  Since chunk IDs are deterministic —
    ``"{document_id}_{chunk_index}"`` — we can build the target IDs directly
    and call ``index.fetch()`` which does an exact key lookup, not ANN search.

    Parameters
    ----------
    document_id : str
        Must match the ``document_id`` stored in chunk metadata at ingest time
        (i.e. the UUID passed from NestJS).
    chunk_index : int
        The index of the reference chunk.
    window : int
        Number of neighbours on each side to retrieve.  Default 1.

    Returns
    -------
    List[Dict]  sorted by chunk_index ascending, each with:
        {
            "chunk_index": int,
            "text":        str,
            "metadata":    Dict,
        }
    """
    index = get_index()

    low = max(0, chunk_index - window)
    high = chunk_index + window  # upper boundary is open-ended — fetch will miss missing IDs

    # Build candidate IDs and filter out obviously invalid ones (negative)
    candidate_ids = [
        f"{document_id}_{i}"
        for i in range(low, high + 1)
    ]

    if not candidate_ids:
        return []

    # index.fetch() returns only the IDs that actually exist — no error on missing ones
    response = index.fetch(ids=candidate_ids)

    neighbors = []
    for vec_id, vector in response.get("vectors", {}).items():
        meta = vector.get("metadata", {})
        neighbors.append({
            "chunk_index": int(meta.get("chunk_index", -1)),
            "text": meta.get("text", ""),
            "metadata": meta,
        })

    # Sort by chunk_index so callers receive a clean ordered window
    neighbors.sort(key=lambda x: x["chunk_index"])
    return neighbors

