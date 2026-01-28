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
                for block in page_dict.get("blocks", []):
                    if block.get("type") != 0:
                        continue
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

                pages.append({
                    "page_num": page_num + 1,
                    "width": width,
                    "height": height,
                    "blocks": blocks,
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
