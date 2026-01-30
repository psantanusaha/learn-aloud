import re
from collections import Counter

import fitz  # PyMuPDF


class PDFProcessor:
    """Extracts text structure and bounding boxes from PDF files using PyMuPDF."""

    def extract_structure(self, pdf_path):
        """Extract text and bounding boxes from every page of the PDF.

        Returns a dict with a list of pages, each containing blocks of text
        with their bounding box coordinates.
        """
        try:
            doc = fitz.open(pdf_path)
            pages = []

            for page_num in range(len(doc)):
                page = doc[page_num]
                page_dict = page.get_text("dict")
                width = page_dict["width"]
                height = page_dict["height"]

                blocks = []
                figures = []
                captions = []
                for block in page_dict.get("blocks", []):
                    if block.get("type") == 1:
                        # Image block — collect if non-trivial size
                        bbox = list(block["bbox"])
                        bw = bbox[2] - bbox[0]
                        bh = bbox[3] - bbox[1]
                        if bw > 30 and bh > 30:
                            figures.append({"bbox": bbox, "label": None})
                    elif block.get("type") == 0:
                        block_text_parts = []
                        for line in block.get("lines", []):
                            for span in line.get("spans", []):
                                text = span.get("text", "").strip()
                                if not text:
                                    continue
                                blocks.append({
                                    "text": text,
                                    "bbox": list(span["bbox"]),
                                    "font": span.get("font", ""),
                                    "size": span.get("size", 0),
                                })
                                block_text_parts.append(text)
                        full = " ".join(block_text_parts).strip()
                        if full.lower().startswith(("figure ", "fig. ", "fig ")):
                            captions.append({
                                "text": full,
                                "bbox": list(block["bbox"]),
                            })

                # Associate captions with the nearest figure above them
                for cap in captions:
                    cap_top = cap["bbox"][1]
                    best_fig = None
                    best_dist = float("inf")
                    for fig in figures:
                        fig_bottom = fig["bbox"][3]
                        dist = cap_top - fig_bottom
                        if 0 <= dist < best_dist:
                            best_dist = dist
                            best_fig = fig
                    if best_fig and best_dist < 50:
                        best_fig["label"] = cap["text"]

                # Label remaining figures by index
                fig_idx = 1
                for fig in figures:
                    if not fig["label"]:
                        fig["label"] = f"Unlabeled image {fig_idx}"
                        fig_idx += 1

                pages.append({
                    "page_num": page_num + 1,
                    "width": width,
                    "height": height,
                    "blocks": blocks,
                    "figures": figures,
                })

            doc.close()
            return {"pages": pages, "total_pages": len(pages)}

        except Exception as e:
            raise RuntimeError(f"Failed to extract PDF structure: {e}")

    def find_text_position(self, pdf_data, search_text, page_num):
        """Find the bounding box position of *search_text* on *page_num*.

        The search is case-insensitive and returns the first matching block.
        """
        if not pdf_data or "pages" not in pdf_data:
            return None

        search_lower = search_text.lower()

        for page in pdf_data["pages"]:
            if page["page_num"] != page_num:
                continue
            for block in page["blocks"]:
                if search_lower in block["text"].lower():
                    return {
                        "found": True,
                        "text": block["text"],
                        "bbox": block["bbox"],
                        "page": page_num,
                    }

        return {"found": False, "text": search_text, "page": page_num}

    def build_outline(self, pdf_data):
        """Build a structured outline from extracted PDF data.

        Returns a dict with:
          - sections: list of {heading, page, level}
          - figures: list of {label, page, bbox}
          - key_terms: list of frequently bolded / capitalized terms
          - abstract: first ~500 chars of body text
        """
        sections = []
        figures_list = []
        bold_terms = Counter()
        body_text = ""
        body_started = False

        # Determine the median font size to detect headings
        all_sizes = []
        for page in pdf_data.get("pages", []):
            for b in page["blocks"]:
                all_sizes.append(b["size"])

        if not all_sizes:
            return {"sections": [], "figures": [], "key_terms": [], "abstract": ""}

        all_sizes.sort()
        median_size = all_sizes[len(all_sizes) // 2]

        for page in pdf_data.get("pages", []):
            page_num = page["page_num"]

            # Collect figures
            for fig in page.get("figures", []):
                figures_list.append({
                    "label": fig["label"],
                    "page": page_num,
                    "bbox": fig["bbox"],
                })

            # Analyze text blocks
            for b in page["blocks"]:
                text = b["text"].strip()
                size = b["size"]
                font = b.get("font", "")

                # Detect headings: significantly larger than median, or bold + larger
                is_bold = "bold" in font.lower() or "black" in font.lower()
                is_larger = size > median_size * 1.15

                if is_larger and len(text) > 2 and len(text) < 120:
                    # Skip noise: attribution lines, arXiv IDs, URLs
                    text_lower = text.lower()
                    if any(skip in text_lower for skip in [
                        "arxiv:", "permission", "attribution", "hereby grants",
                        "http://", "https://", "doi:", "copyright",
                        "proceedings of", "published in",
                    ]):
                        continue
                    # Determine heading level by size difference
                    level = 1 if size > median_size * 1.5 else 2
                    sections.append({
                        "heading": text,
                        "page": page_num,
                        "level": level,
                    })

                # Collect bold terms (potential key terms)
                if is_bold and not is_larger and len(text) > 2 and len(text) < 60:
                    # Clean and count
                    clean = text.strip(".,;:()[]")
                    if clean and not clean.isdigit():
                        bold_terms[clean] += 1

                # Build body text for abstract extraction
                if not body_started and text.lower().startswith("abstract"):
                    body_started = True
                if body_started and len(body_text) < 600:
                    body_text += text + " "

        # Extract top key terms (by frequency, skip duplicates of headings)
        heading_lower = {s["heading"].lower() for s in sections}
        key_terms = [
            term for term, count in bold_terms.most_common(20)
            if term.lower() not in heading_lower
        ][:12]

        # Clean abstract: take text after "Abstract" keyword
        abstract = body_text.strip()
        abs_match = re.search(r"(?i)abstract\s*", abstract)
        if abs_match:
            abstract = abstract[abs_match.end():]
        abstract = abstract[:500]

        return {
            "sections": sections,
            "figures": figures_list,
            "key_terms": key_terms,
            "abstract": abstract,
        }
