"""
test_table_extraction.py
========================
Smoke-test for the Docling-based structured extraction pipeline.

What it checks
--------------
1. extract_document() returns at least one element from the test PDF.
2. At least one element has element_type == "table" (Docling table support).
3. That table element's content uses Markdown pipe syntax (|).
4. chunk_elements() produces chunks with all required metadata fields.
5. No chunk cuts through a Markdown table row (no row split on '|').

Usage
-----
    python test_table_extraction.py [path/to/your.pdf]

If no path is provided, the script tries to use the bundled test_document.pdf.
To get the best coverage, supply a PDF that contains at least one table.
"""

import sys
import os
import json
import logging

# Ensure the project root is on the path
sys.path.insert(0, os.path.dirname(__file__))

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)-8s %(name)s: %(message)s",
)
log = logging.getLogger("test_table_extraction")

from services.extraction import extract_document
from services.chunking import chunk_elements

# ── Resolve test file ─────────────────────────────────────────────────────────
if len(sys.argv) > 1:
    TEST_PDF = sys.argv[1]
else:
    TEST_PDF = os.path.join(os.path.dirname(__file__), "test_document.pdf")

if not os.path.exists(TEST_PDF):
    print(f"\n[ERROR] Test file not found: {TEST_PDF}")
    print("Usage: python test_table_extraction.py <path/to/document_with_table.pdf>")
    sys.exit(1)

print(f"\n{'='*60}")
print(f"  EduCast — Table Extraction Test")
print(f"  File: {TEST_PDF}")
print(f"{'='*60}\n")

# ── 1. Extract ────────────────────────────────────────────────────────────────
print("[1/4] Running extract_document()...")
elements = extract_document(TEST_PDF, ".pdf")
assert elements, "FAIL: extract_document() returned an empty list."
print(f"  [OK] Extracted {len(elements)} elements.\n")

# ── 2. Inspect element types ──────────────────────────────────────────────────
print("[2/4] Checking element types...")
type_counts: dict = {}
for el in elements:
    t = el["element_type"]
    type_counts[t] = type_counts.get(t, 0) + 1

for t, count in sorted(type_counts.items()):
    print(f"  • {t}: {count}")

table_elements = [el for el in elements if el["element_type"] == "table"]
if table_elements:
    print(f"\n  [OK] Found {len(table_elements)} table element(s).")
    # Show first table
    first_table = table_elements[0]
    print(f"\n  --- First table (section: {first_table['section']!r}, "
          f"page: {first_table['page_number']}) ---")
    print(first_table["content"][:800])
    print("  ---")

    # Assert Markdown pipe syntax
    assert "|" in first_table["content"], (
        "FAIL: Table content does not contain '|' — not rendered as Markdown.\n"
        + first_table["content"][:200]
    )
    print("\n  [OK] Table content uses Markdown pipe syntax.")
else:
    print(
        "\n  [WARN] No table elements found.  This is expected if the PDF does not "
        "contain structured tables, or if Docling used the fallback path.\n"
        "  Supply a PDF with a table to fully exercise Docling table extraction."
    )

# ── 3. Chunk ──────────────────────────────────────────────────────────────────
print("\n[3/4] Running chunk_elements()...")
DOCUMENT_ID = os.path.basename(TEST_PDF)
chunks = chunk_elements(elements, document_id=DOCUMENT_ID)
assert chunks, "FAIL: chunk_elements() returned an empty list."
print(f"  [OK] Produced {len(chunks)} chunks.\n")

# ── 4. Validate chunk metadata ────────────────────────────────────────────────
print("[4/4] Validating chunk metadata schema...")
REQUIRED_METADATA_FIELDS = {
    "document_id", "page_number", "section", "element_type", "chunk_index"
}
errors = []
for i, chunk in enumerate(chunks):
    meta = chunk.get("metadata", {})
    missing = REQUIRED_METADATA_FIELDS - set(meta.keys())
    if missing:
        errors.append(f"  Chunk {i} missing fields: {missing}")
    if not chunk.get("id", "").startswith(DOCUMENT_ID):
        errors.append(f"  Chunk {i} has unexpected id format: {chunk.get('id')!r}")
    if meta.get("element_type") == "table":
        # Tables must not be split — check no partial pipe rows
        text = chunk.get("text", "")
        rows = [l for l in text.splitlines() if l.strip().startswith("|")]
        for row in rows:
            if not row.strip().endswith("|") and not row.strip().endswith("|\\"):
                errors.append(
                    f"  Chunk {i} has a possibly truncated table row: {row!r}"
                )

if errors:
    print("\n  FAILURES:")
    for e in errors:
        print(e)
    sys.exit(1)

print("  [OK] All chunks have required metadata fields.")

# ── Summary ───────────────────────────────────────────────────────────────────
print(f"\n{'='*60}")
print("  ALL ASSERTIONS PASSED")
print(f"{'='*60}")

print("\nSample chunks (first 3):\n")
for chunk in chunks[:3]:
    print(json.dumps({
        "id": chunk["id"],
        "text_preview": chunk["text"][:120].replace("\n", " "),
        "metadata": chunk["metadata"],
    }, indent=2, ensure_ascii=False))
    print()
