"""Structure-aware chunking with parent/child hierarchy.

Headings are semantic boundaries; tables, code and formulas stay atomic. Child
chunks are retrieval units and the parent section is returned as context after a
child hit (small-to-big).
"""
from __future__ import annotations

from .models import new_id
from .parsing import ParsedBlock

MAX_CHARS = 460
OVERLAP = 60


def estimate_tokens(text: str) -> int:
    chinese = sum(1 for ch in text if "\u3400" <= ch <= "\u9fff")
    others = max(0, len(text) - chinese)
    return max(1, int(chinese / 1.7 + others / 4))


def chunk_blocks(blocks: list[ParsedBlock]) -> list[dict]:
    sections: dict[tuple[str, ...], list[ParsedBlock]] = {}
    order: list[tuple[str, ...]] = []
    for block in blocks:
        key = tuple(block.heading_path) or ("正文",)
        if key not in sections:
            sections[key] = []
            order.append(key)
        sections[key].append(block)

    chunks: list[dict] = []
    seq = 0
    for key in order:
        section_blocks = sections[key]
        body = "\n\n".join(b.text for b in section_blocks).strip()
        if not body:
            continue
        parent_id = new_id("ch")
        chunks.append(
            {
                "id": parent_id,
                "seq": seq,
                "heading_path": list(key),
                "page": section_blocks[0].page,
                "bbox": section_blocks[0].bbox,
                "block_type": "section",
                "text": body,
                "token_count": estimate_tokens(body),
                "parent_id": None,
                "is_parent": True,
            }
        )
        seq += 1

        pending = ""
        overlap_tail = ""
        for block in section_blocks:
            text = block.text.strip()
            if not text:
                continue
            atomic = block.type in {"table", "code"}
            pieces: list[str]
            if atomic:
                pieces = [text] if len(text) <= MAX_CHARS * 1.6 else _split_long(text)
            else:
                pieces = _split_long(text)
            for piece in pieces:
                candidate = (pending + "\n\n" + piece).strip() if pending else piece
                if len(candidate) <= MAX_CHARS or not pending:
                    pending = candidate
                    continue
                chunks.append(
                    _child(parent_id, seq, key, section_blocks[0], pending, overlap_tail, block.type)
                )
                seq += 1
                overlap_tail = pending[-OVERLAP:]
                pending = (overlap_tail + "\n\n" + piece).strip() if overlap_tail else piece
        if pending.strip():
            chunks.append(
                _child(
                    parent_id,
                    seq,
                    key,
                    section_blocks[0],
                    pending.strip(),
                    overlap_tail,
                    section_blocks[-1].type,
                )
            )
            seq += 1
    # fix page per chunk using block page is approximate for single-page sections;
    # multi-page PDFs are split per page section marker in ingestion if needed.
    return chunks


def _child(parent_id, seq, key, first_block, text, _overlap, block_type):
    return {
        "id": new_id("ch"),
        "seq": seq,
        "heading_path": list(key),
        "page": first_block.page,
        "bbox": first_block.bbox,
        "block_type": block_type,
        "text": text,
        "token_count": estimate_tokens(text),
        "parent_id": parent_id,
        "is_parent": False,
    }


def _split_long(text: str) -> list[str]:
    if len(text) <= MAX_CHARS:
        return [text]
    sentences = []
    start = 0
    for index, ch in enumerate(text):
        if ch in "。！？!?；;\n" and index + 1 - start >= 80:
            sentences.append(text[start : index + 1].strip())
            start = index + 1
    if start < len(text):
        sentences.append(text[start:].strip())
    pieces: list[str] = []
    buffer = ""
    for sentence in sentences:
        if len(buffer) + len(sentence) <= MAX_CHARS:
            buffer += sentence
            continue
        if buffer:
            pieces.append(buffer.strip())
        if len(sentence) > MAX_CHARS:
            for i in range(0, len(sentence), MAX_CHARS):
                pieces.append(sentence[i : i + MAX_CHARS].strip())
            buffer = ""
        else:
            buffer = sentence
    if buffer:
        pieces.append(buffer.strip())
    return [piece for piece in pieces if piece]
