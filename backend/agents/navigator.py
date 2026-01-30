import re


class Navigator:
    """Citation and bibliography tracker for PDF documents."""

    # Patterns that typically start a references section
    _SECTION_HEADERS = re.compile(
        r"^(references|bibliography|works cited)\s*$", re.IGNORECASE
    )
    # Pattern for numbered references like [1], [2], etc.
    _REF_NUMBER = re.compile(r"^\[(\d+)\]")

    def list_references(self, pdf_data):
        """Extract bibliography entries from the PDF.

        Looks for a References/Bibliography section header, then parses
        numbered entries of the form ``[N] text``.  Falls back to scanning
        the last 2 pages if no header is found.

        Returns a list of dicts with number, text, and page.
        """
        if not pdf_data or "pages" not in pdf_data:
            return []

        pages = pdf_data["pages"]
        ref_start_page = None
        ref_start_block = None

        # Pass 1: find the references section header
        for page in pages:
            for i, block in enumerate(page["blocks"]):
                if self._SECTION_HEADERS.match(block["text"].strip()):
                    ref_start_page = page["page_num"]
                    ref_start_block = i + 1
                    break
            if ref_start_page is not None:
                break

        # Collect candidate text blocks
        candidates = []
        if ref_start_page is not None:
            for page in pages:
                if page["page_num"] < ref_start_page:
                    continue
                start = ref_start_block if page["page_num"] == ref_start_page else 0
                for block in page["blocks"][start:]:
                    candidates.append({
                        "text": block["text"],
                        "page": page["page_num"],
                        "bbox": block["bbox"],
                    })
        else:
            # Fallback: last 2 pages
            for page in pages[-2:]:
                for block in page["blocks"]:
                    candidates.append({
                        "text": block["text"],
                        "page": page["page_num"],
                        "bbox": block["bbox"],
                    })

        # Pass 2: parse numbered reference entries
        references = []
        current_ref = None

        for cand in candidates:
            m = self._REF_NUMBER.match(cand["text"])
            if m:
                if current_ref:
                    references.append(current_ref)
                current_ref = {
                    "number": int(m.group(1)),
                    "text": cand["text"],
                    "page": cand["page"],
                    "bbox": cand["bbox"],
                }
            elif current_ref:
                # Continuation of the previous reference entry
                current_ref["text"] += " " + cand["text"]

        if current_ref:
            references.append(current_ref)

        return references

    def find_citation(self, pdf_data, reference):
        """Find a specific citation by number (e.g. ``"3"`` or ``"[3]"``)
        or by text match (e.g. ``"Smith 2020"``).

        Returns a dict with ``found``, and if found: ``number``, ``text``,
        ``page``, ``bbox``.
        """
        refs = self.list_references(pdf_data)
        if not refs:
            return {"found": False, "reference": reference}

        # Try numeric lookup first
        clean = reference.strip().strip("[]")
        if clean.isdigit():
            num = int(clean)
            for ref in refs:
                if ref["number"] == num:
                    return {"found": True, **ref}
            return {"found": False, "reference": reference}

        # Text-based search (case-insensitive substring)
        query = reference.lower()
        for ref in refs:
            if query in ref["text"].lower():
                return {"found": True, **ref}

        return {"found": False, "reference": reference}
