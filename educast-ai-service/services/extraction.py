"""
services/extraction.py
======================
Document extraction pipeline for EduCast AI Service.

Primary path  : Docling — returns structured elements (headings, text blocks,
                tables rendered as Markdown) with page numbers and section context.

Fallback path : PyMuPDF (PDF) / python-pptx (PPTX) — triggered automatically
                if Docling raises any exception.  All fallback elements are
                tagged as element_type="text" with section=None.

Return schema (both paths)
--------------------------
List of dicts, each with:
    {
        "page_number":   int,         # 1-based page or slide number
        "section":       str | None,  # title of the nearest parent heading
        "element_type":  str,         # "heading" | "text" | "table"
        "content":       str,         # plain text, or Markdown for tables
    }
"""

import logging
import time
import fitz  # PyMuPDF — fallback for PDF
from pptx import Presentation  # fallback for PPTX
from typing import List, Dict, Any, Optional, Tuple

log = logging.getLogger(__name__)

# Guard torch import — extraction.py may run on CPU-only machines
try:
    import torch as _torch
    _TORCH_AVAILABLE = _torch.cuda.is_available()
except ImportError:
    _torch = None  # type: ignore
    _TORCH_AVAILABLE = False


def _gpu_empty_cache() -> None:
    """Release un-used PyTorch GPU cache blocks if CUDA is available."""
    if _TORCH_AVAILABLE and _torch is not None:
        _torch.cuda.empty_cache()


def _vram_stats() -> str:
    """Return a compact VRAM usage string for log messages."""
    if _TORCH_AVAILABLE and _torch is not None:
        alloc = _torch.cuda.memory_allocated() / 1024 ** 3
        res   = _torch.cuda.memory_reserved()  / 1024 ** 3
        return f"alloc={alloc:.3f} GB reserved={res:.3f} GB"
    return "CUDA N/A"


# ---------------------------------------------------------------------------
# Docling-based extraction (primary path)
# ---------------------------------------------------------------------------

def _parse_docling_result(result, current_section: Optional[str]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    elements: List[Dict[str, Any]] = []
    doc = result.document
    for item, _level in doc.iterate_items():
        from docling_core.types.doc.items.text import SectionHeaderItem, TextItem
        from docling_core.types.doc.items.table.table import TableItem
        from docling_core.types.doc.items.picture.picture import PictureItem
        page_number: int = 1
        if hasattr(item, "prov") and item.prov:
            page_number = item.prov[0].page_no + 1

        if isinstance(item, SectionHeaderItem):
            current_section = item.text.strip()
            elements.append({
                "page_number": page_number,
                "section": current_section,
                "element_type": "heading",
                "content": item.text.strip(),
            })
        elif isinstance(item, TableItem):
            md_table = item.export_to_markdown()
            if md_table.strip():
                elements.append({
                    "page_number": page_number,
                    "section": current_section,
                    "element_type": "table",
                    "content": md_table.strip(),
                })
        elif isinstance(item, TextItem):
            text = item.text.strip()
            if text:
                elements.append({
                    "page_number": page_number,
                    "section": current_section,
                    "element_type": "text",
                    "content": text,
                })
    return elements, current_section

def _extract_with_docling(file_path: str) -> List[Dict[str, Any]]:
    """
    Hybrid page-by-page extraction for PDF. PPTX uses legacy fallback or docling if needed.
    """
    if not file_path.lower().endswith('.pdf'):
        from docling.document_converter import DocumentConverter
        converter = DocumentConverter()
        try:
            result = converter.convert(file_path)
            elements, _ = _parse_docling_result(result, None)
        finally:
            del converter          # explicit destructor so GPU weights are freed
            _gpu_empty_cache()
        return elements

    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
    from docling.datamodel.base_models import InputFormat

    # Use GPU if available
    accelerator_options = AcceleratorOptions(
        num_threads=8,
        device=AcceleratorDevice.AUTO
    )

    # Converter for pages with text but visuals (equations/tables/images) -> NO OCR
    pipeline_options = PdfPipelineOptions(
        do_ocr=False,
        do_formula_enrichment=False,
        accelerator_options=accelerator_options
    )
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
    )

    # Converter for pages with NO text -> OCR
    pipeline_options_ocr = PdfPipelineOptions(
        do_ocr=True,
        do_formula_enrichment=False,
        accelerator_options=accelerator_options
    )
    converter_ocr = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options_ocr)}
    )

    elements: List[Dict[str, Any]] = []
    current_section = None

    # Counters for the formula-enrichment timing hypothesis
    pages_docling_no_ocr   = 0  # has visuals, formula model active
    pages_docling_ocr      = 0  # no text, OCR + formula model
    pages_pymupdf          = 0  # pure text, no Docling / no formula model
    
    try:
        pdf_doc = fitz.open(file_path)
        total_pages = len(pdf_doc)
        log.info("[VRAM] before PDF hybrid loop: %s", _vram_stats())
        for page_num in range(total_pages):
            page_elements = []
            try:
                page = pdf_doc.load_page(page_num)
                text = page.get_text()
                text_str = text if isinstance(text, str) else ""
                has_text = len(text_str.strip()) > 0
                has_images = len(page.get_images()) > 0
                has_drawings = len(page.get_drawings()) > 0
                docling_page = page_num + 1

                if not has_text:
                    log.info(f"Page {docling_page} has no text. Using Docling with OCR.")
                    res = converter_ocr.convert(file_path, page_range=(docling_page, docling_page))
                    page_elements, current_section = _parse_docling_result(res, current_section)
                    del res  # release intermediate result objects
                    pages_docling_ocr += 1
                elif has_images or has_drawings:
                    log.info(f"Page {docling_page} has visuals. Using Docling without OCR.")
                    res = converter.convert(file_path, page_range=(docling_page, docling_page))
                    page_elements, current_section = _parse_docling_result(res, current_section)
                    del res
                    pages_docling_no_ocr += 1
                else:
                    log.info(f"Page {docling_page} is pure text. Using PyMuPDF.")
                    if text_str.strip():
                        page_elements = [{
                            "page_number": docling_page,
                            "section": current_section,
                            "element_type": "text",
                            "content": text_str.strip(),
                        }]
                    pages_pymupdf += 1
                elements.extend(page_elements)
                # Release GPU cache after each Docling page to prevent accumulation
                _gpu_empty_cache()
                log.debug("[VRAM] after page %d: %s", docling_page, _vram_stats())
            except Exception as page_err:
                log.warning(f"Error processing page {page_num + 1} of {file_path}: {page_err}")
                _gpu_empty_cache()  # free cache even on page error
                continue
        pdf_doc.close()
        log.info("[VRAM] after PDF hybrid loop: %s", _vram_stats())

        # ── Formula-enrichment timing breakdown ──────────────────────────────
        pages_formula_model = pages_docling_no_ocr + pages_docling_ocr
        log.info(
            "[TIMING] Page routing for %s: "
            "%d/%d pages used Docling+formula (do_formula_enrichment=True) "
            "[%d with visuals/no-OCR, %d OCR-only], "
            "%d/%d pages used PyMuPDF (pure text, no formula model).",
            file_path,
            pages_formula_model, total_pages,
            pages_docling_no_ocr, pages_docling_ocr,
            pages_pymupdf, total_pages,
        )
        print(
            f"[TIMING] {total_pages} pages total — "
            f"{pages_formula_model} hit formula/enrichment model "
            f"({pages_docling_no_ocr} visual, {pages_docling_ocr} OCR), "
            f"{pages_pymupdf} used fast PyMuPDF path."
        )
    except Exception as e:
        log.error("Error opening PDF with fitz for hybrid processing: %s", e)
        raise
    finally:
        # Explicitly destroy converters so Python/PyTorch can release GPU tensors
        del converter
        del converter_ocr
        _gpu_empty_cache()
        log.info("[VRAM] after converter destruction + empty_cache: %s", _vram_stats())

    return elements



# ---------------------------------------------------------------------------
# Legacy fallback helpers (kept intact for robustness)
# ---------------------------------------------------------------------------

def extract_text_from_pdf(file_path: str) -> List[Dict[str, Any]]:
    """
    Fallback: extract text from a PDF file page by page using PyMuPDF.
    Returns elements with element_type='text' and section=None.
    """
    elements: List[Dict[str, Any]] = []
    try:
        doc = fitz.open(file_path)
        for page_num in range(len(doc)):
            page = doc.load_page(page_num)
            text = page.get_text()
            text_str = text if isinstance(text, str) else ""
            if text_str.strip():
                elements.append({
                    "page_number": page_num + 1,
                    "section": None,
                    "element_type": "text",
                    "content": text_str.strip(),
                })
        doc.close()
    except Exception as e:
        log.error("PyMuPDF fallback failed for %s: %s", file_path, e)
        raise
    return elements


def extract_text_from_pptx(file_path: str) -> List[Dict[str, Any]]:
    """
    Fallback: extract text from a PPTX file slide by slide using python-pptx.
    Returns elements with element_type='text' and section=None.
    Tables in slides are flattened to plain text in this fallback path.
    """
    elements: List[Dict[str, Any]] = []
    try:
        prs = Presentation(file_path)
        for i, slide in enumerate(prs.slides):
            text_runs = []
            for shape in slide.shapes:
                if not getattr(shape, "has_text_frame", False):
                    continue
                text_frame = getattr(shape, "text_frame", None)
                if not text_frame:
                    continue
                for paragraph in text_frame.paragraphs:
                    for run in paragraph.runs:
                        text_runs.append(run.text)
            text = " ".join(text_runs)
            if text.strip():
                elements.append({
                    "page_number": i + 1,
                    "section": None,
                    "element_type": "text",
                    "content": text.strip(),
                })
    except Exception as e:
        log.error("python-pptx fallback failed for %s: %s", file_path, e)
        raise
    return elements


def extract_text_from_docx(file_path: str) -> List[Dict[str, Any]]:
    """
    Fallback: extract text from a DOCX file paragraph by paragraph using python-docx.
    Returns elements with element_type='text' and section=None.
    """
    elements: List[Dict[str, Any]] = []
    try:
        from docx import Document
        doc = Document(file_path)
        # Note: DOCX doesn't have a strict concept of "pages" easily accessible,
        # so we default to page_number=1 for all text chunks in the fallback.
        text = "\n".join(para.text for para in doc.paragraphs if para.text.strip())
        if text.strip():
            elements.append({
                "page_number": 1,
                "section": None,
                "element_type": "text",
                "content": text.strip(),
            })
    except Exception as e:
        log.error("python-docx fallback failed for %s: %s", file_path, e)
        raise
    return elements


def _fallback_extract(file_path: str, file_type: str) -> List[Dict[str, Any]]:
    """Route to the appropriate legacy extractor based on file extension."""
    if file_type.lower() == ".pdf":
        return extract_text_from_pdf(file_path)
    elif file_type.lower() == ".pptx":
        return extract_text_from_pptx(file_path)
    elif file_type.lower() == ".docx":
        return extract_text_from_docx(file_path)
    else:
        raise ValueError(f"Unsupported file type for fallback extraction: {file_type}")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_document(file_path: str, file_type: str) -> List[Dict[str, Any]]:
    """
    Extract structured elements from a PDF, PPTX, or DOCX file.

    Tries Docling first.  If Docling fails (any exception), logs a warning
    and falls back to the legacy PyMuPDF / python-pptx / python-docx extractors.

    Parameters
    ----------
    file_path : str
        Absolute path to the file on disk.
    file_type : str
        File extension, e.g. '.pdf', '.pptx', or '.docx'.

    Returns
    -------
    List[Dict]
        Flat list of document elements — see module docstring for schema.
    """
    try:
        elements = _extract_with_docling(file_path)
        if elements:
            log.info("Docling extracted %d elements from %s", len(elements), file_path)
            return elements
        # Docling succeeded but returned nothing — fall through to legacy
        log.warning(
            "Docling returned no elements for %s — falling back to legacy extractor.",
            file_path,
        )
    except Exception as exc:
        log.warning(
            "Docling failed for %s (%s) — falling back to legacy extractor.",
            file_path,
            exc,
        )

    return _fallback_extract(file_path, file_type)


# ---------------------------------------------------------------------------
# Backward-compat shim (used by old callers that expect the old flat schema)
# ---------------------------------------------------------------------------

def extract_text(file_path: str, file_type: str) -> List[Dict[str, Any]]:
    """
    Legacy entry point — kept for backward compatibility.

    Delegates to extract_document() and converts the new element schema back
    to the old {"page_or_slide": int, "text": str} format so existing callers
    continue to work without modification.
    """
    elements = extract_document(file_path, file_type)
    # Group by page and concatenate — mimics the old behaviour
    from collections import defaultdict
    pages: dict = defaultdict(list)
    for el in elements:
        pages[el["page_number"]].append(el["content"])

    return [
        {"page_or_slide": pnum, "text": "\n\n".join(texts)}
        for pnum, texts in sorted(pages.items())
    ]
