"""
services/chunking.py
====================
Structure-aware chunking for EduCast AI Service.

Strategy
--------
1. Group consecutive document elements that share the same *section* heading
   into a single *section group*.
2. For each group, estimate token count (characters ÷ 4).
   - If the group fits within MAX_TOKENS_PER_CHUNK (1000 tokens ≈ 4000 chars):
     emit it as a single chunk.
   - If the group is too large: sub-split the **text-only** elements with
     RecursiveCharacterTextSplitter.  Tables are always kept intact (never
     split mid-table).
3. Every chunk carries rich metadata for downstream RAG filtering and
   neighbor-context retrieval.

Chunk schema
------------
{
    "id":    str,          # "{document_id}_{chunk_index}"
    "text":  str,          # chunk content (plain text or Markdown table)
    "metadata": {
        "document_id":   str,
        "page_number":   int,
        "section":       str | None,
        "element_type":  str,   # "text" | "table" | "heading"
        "chunk_index":   int,   # global position in the document
    }
}
"""

import logging
from typing import List, Dict, Any, Optional
from langchain_text_splitters import RecursiveCharacterTextSplitter

log = logging.getLogger(__name__)

# ≈ 1000 tokens * 4 chars/token
MAX_CHARS_PER_CHUNK = 4000
# Sub-splitter settings (mirrors the old fixed-size chunker)
SUB_CHUNK_SIZE = 3200        # ~800 tokens
SUB_CHUNK_OVERLAP = 400      # ~100 tokens

_text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=SUB_CHUNK_SIZE,
    chunk_overlap=SUB_CHUNK_OVERLAP,
    length_function=len,
    separators=["\n\n", "\n", " ", ""],
)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _is_table(element: Dict[str, Any]) -> bool:
    return element.get("element_type") == "table"


def _group_by_section(
    elements: List[Dict[str, Any]],
) -> List[List[Dict[str, Any]]]:
    """
    Partition elements into groups where all elements within a group share
    the same `section` value.  A change in section heading triggers a new group.
    """
    if not elements:
        return []

    groups: List[List[Dict[str, Any]]] = []
    current_group: List[Dict[str, Any]] = [elements[0]]
    current_section = elements[0].get("section")

    for el in elements[1:]:
        if el.get("section") == current_section:
            current_group.append(el)
        else:
            groups.append(current_group)
            current_group = [el]
            current_section = el.get("section")

    groups.append(current_group)
    return groups


def _representative_page(group: List[Dict[str, Any]]) -> int:
    """Return the page number of the first element in a group."""
    return group[0].get("page_number", 1)


def _representative_section(group: List[Dict[str, Any]]) -> Optional[str]:
    return group[0].get("section")


def _representative_type(group: List[Dict[str, Any]]) -> str:
    """
    Pick the dominant element_type for a mixed group.
    Priority: table > heading > text
    """
    types = {el.get("element_type") for el in group}
    if "table" in types:
        return "table"
    if "heading" in types:
        return "heading"
    return "text"


def _emit_chunk(
    text: str,
    document_id: str,
    chunk_index: int,
    page_number: int,
    section: Optional[str],
    element_type: str,
) -> Dict[str, Any]:
    return {
        "id": f"{document_id}_{chunk_index}",
        "text": text,
        "metadata": {
            "document_id": document_id,
            "page_number": page_number,
            "section": section,
            "element_type": element_type,
            "chunk_index": chunk_index,
        },
    }


def _split_group(
    group: List[Dict[str, Any]],
    document_id: str,
    start_index: int,
    page_number: int,
    section: Optional[str],
) -> List[Dict[str, Any]]:
    """
    Sub-split a section group that exceeds MAX_CHARS_PER_CHUNK.

    Tables in the group are always emitted whole (never split).
    Consecutive text/heading elements are concatenated and then split
    with RecursiveCharacterTextSplitter.
    """
    chunks: List[Dict[str, Any]] = []
    idx = start_index

    # We process elements in order; accumulate text elements, flush on tables
    text_buffer: List[str] = []
    text_page: int = page_number

    def flush_text_buffer() -> int:
        nonlocal idx
        combined = "\n\n".join(text_buffer)
        sub_chunks = _text_splitter.split_text(combined)
        for sub in sub_chunks:
            if sub.strip():
                chunks.append(_emit_chunk(sub, document_id, idx, text_page, section, "text"))
                idx += 1
        text_buffer.clear()
        return idx

    for el in group:
        if _is_table(el):
            # Flush accumulated text first
            if text_buffer:
                flush_text_buffer()
            # Emit the table as a single, unsplit chunk
            chunks.append(_emit_chunk(
                el["content"], document_id, idx,
                el.get("page_number", page_number), section, "table",
            ))
            idx += 1
        else:
            if not text_buffer:
                text_page = el.get("page_number", page_number)
            text_buffer.append(el["content"])

    if text_buffer:
        flush_text_buffer()

    return chunks


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def chunk_elements(
    elements: List[Dict[str, Any]],
    document_id: str,
) -> List[Dict[str, Any]]:
    """
    Convert a list of structured document elements into chunks for embedding.

    Parameters
    ----------
    elements : List[Dict]
        Output of `services.extraction.extract_document()`.
    document_id : str
        Unique identifier for the document (e.g. filename).  Used to build
        chunk IDs and stored in metadata for neighbor-context queries.

    Returns
    -------
    List[Dict]  — see module docstring for schema.
    """
    if not elements:
        return []

    chunks: List[Dict[str, Any]] = []
    chunk_index = 0

    for group in _group_by_section(elements):
        page_number = _representative_page(group)
        section = _representative_section(group)
        total_chars = sum(len(el.get("content", "")) for el in group)

        if total_chars <= MAX_CHARS_PER_CHUNK:
            # ── Small group: emit as a single chunk ──────────────────────────
            text = "\n\n".join(el["content"] for el in group if el.get("content"))
            dominant_type = _representative_type(group)
            if text.strip():
                chunks.append(_emit_chunk(
                    text, document_id, chunk_index, page_number, section, dominant_type,
                ))
                chunk_index += 1
        else:
            # ── Large group: sub-split (preserving tables intact) ─────────────
            sub_chunks = _split_group(group, document_id, chunk_index, page_number, section)
            chunks.extend(sub_chunks)
            chunk_index += len(sub_chunks)

    log.info(
        "chunk_elements: %d elements → %d chunks (document_id=%s)",
        len(elements), len(chunks), document_id,
    )
    return chunks


# ---------------------------------------------------------------------------
# Backward-compat shim
# ---------------------------------------------------------------------------

def chunk_text(
    extracted_data: List[Dict[str, Any]],
    filename: str,
) -> List[Dict[str, Any]]:
    """
    Legacy entry point — kept for backward compatibility.

    Converts the old flat schema {"page_or_slide": int, "text": str} into
    the new element schema and delegates to chunk_elements().
    """
    elements = []
    for item in extracted_data:
        page = item.get("page_or_slide", item.get("page_number", 1))
        elements.append({
            "page_number": page,
            "section": None,
            "element_type": "text",
            "content": item.get("text", item.get("content", "")),
        })
    return chunk_elements(elements, document_id=filename)
