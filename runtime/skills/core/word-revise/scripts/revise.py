#!/usr/bin/env python3
"""Redline-aware Word document revision engine.

Turns plain text edits into OOXML tracked changes (w:ins / w:del) attributed to a
configurable author (default "sculab"), and - the reason this tool exists - does so
correctly on documents that ALREADY contain tracked changes from any author.

Why a dedicated engine (not blind string replacement):
  - In a redlined document the "visible" text is split across <w:ins>/<w:del>
    wrappers, so the target string is never contiguous in document.xml. Plain
    search-and-replace cannot find it (or, worse, silently mutates an existing
    revision without creating a new one).
  - Re-revising requires author-aware rules:
      * our own prior <w:ins>  -> superseded in place (no nested same-author marks)
      * our own prior <w:del>  -> restoring that text removes our own <w:del>
      * another author's <w:ins> -> our <w:del> is NESTED inside their <w:ins>
      * another author's <w:del> -> our <w:ins> is placed AFTER their <w:del>
      * normal text            -> <w:del> + <w:ins> siblings at paragraph level

Subcommands:
  status   <unpacked> [--limit N] [--para N]          dump paragraphs with visible text
  summary  <unpacked>                                  redline authors/usage report
  apply    <unpacked> --edits edits.json [--author A]  apply tracked-change edits
  apply    <unpacked> --old TEXT --new TEXT [--author A] [--all]
  pack     <unpacked> <output.docx> [--original IN] [--author A]
  verify   <unpacked> --original IN [--author A]       author-strip consistency check
  fold     <unpacked> --author A --out OUT.docx        accept A's changes (clean copy)

Edits JSON schema (list of edit objects, applied in order):
  {"para": 12, "old": "...", "new": "...", "all": false}
      para: optional 0-based paragraph index from `status`. Omit to search every paragraph.
      old : optional; text to locate in the paragraph's CURRENT visible text.
            Omit to treat the paragraph's whole visible text as `old`.
      new : replacement text ("" deletes). Used verbatim.
      all : replace every occurrence (default: first occurrence only).
  Example:
    [
      {"para": 2, "old": "四川省重点实验室", "new": "四川省重点实验室（筹）"},
      {"para": 6, "new": ""},
      {"old": "依托单位：（盖章）", "new": "依托单位：（盖章）　二〇二六年八月"}
    ]
"""

import argparse
import difflib
import json
import re
import sys
import zipfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W_ = "{%s}" % W
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

WRAP_TAGS = ("ins", "del", "moveTo", "moveFrom")
WRAP_KIND = {"ins": "ins", "del": "del", "moveTo": "ins", "moveFrom": "del"}


def tag(name):
    return W_ + name


def lname(el, name):
    return isinstance(el.tag, str) and el.tag.split("}")[-1] == name


def author_of(el):
    return el.get(W_ + "author") if el is not None else None


def child(el, name):
    for c in el:
        if lname(c, name):
            return c
    return None


def children(el, name):
    return [c for c in el if lname(c, name)]


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Segment model
# ---------------------------------------------------------------------------

class Item:
    """One text fragment (w:t or w:delText) with its redline context."""

    __slots__ = ("kind", "elem", "run", "rpr", "wrappers", "top")

    def __init__(self, kind, elem, run, rpr, wrappers, top):
        self.kind = kind          # "t" or "d"
        self.elem = elem          # w:t / w:delText element
        self.run = run            # containing w:r
        self.rpr = rpr            # w:rPr element or None
        self.wrappers = wrappers  # list of (wrap_tag, author), outer -> inner
        self.top = top            # ancestor-or-self that is a direct child of w:p

    @property
    def text(self):
        return self.elem.text or ""

    @property
    def innermost(self):
        return self.wrappers[-1] if self.wrappers else None

    def in_wrap(self, tag_name, author=None):
        node = self.run
        while node is not None:
            if lname(node, tag_name) or (tag_name == "ins" and lname(node, "moveTo")) \
                    or (tag_name == "del" and lname(node, "moveFrom")):
                if author is None or author_of(node) == author:
                    return node
            node = node.getparent()
        return None

    def contributes_to_visible(self):
        if self.kind == "d":
            return False
        inn = self.innermost
        if inn is None:
            return True
        return WRAP_KIND[inn[0]] == "ins"

    def contributes_to_original(self):
        if self.kind == "d":
            return True
        inn = self.innermost
        if inn is None:
            return True
        return WRAP_KIND[inn[0]] == "del"


def build_items(p_elem):
    items = []
    stack = []

    def walk(node, top):
        for el in node:
            if not isinstance(el.tag, str):
                continue
            name = el.tag.split("}")[-1]
            if name in WRAP_TAGS:
                stack.append((name, author_of(el)))
                walk(el, top if top is not None else el)
                stack.pop()
            elif name == "r":
                rpr = child(el, "rPr")
                for t in el:
                    if lname(t, "t"):
                        items.append(Item("t", t, el, rpr, list(stack), top if top is not None else el))
                    elif lname(t, "delText"):
                        items.append(Item("d", t, el, rpr, list(stack), top if top is not None else el))
            elif name == "p":
                continue
            else:
                # hyperlink, smartTag, sdt, ... may contain runs
                walk(el, top if top is not None else el)

    walk(p_elem, None)
    return items


def visible_text(items):
    return "".join(i.text for i in items if i.contributes_to_visible())


def item_at_visible_pos(items, pos):
    offset = 0
    for item in items:
        if not item.contributes_to_visible():
            continue
        if offset <= pos < offset + len(item.text):
            return item
        offset += len(item.text)
    return None


def redline_authors_in(el):
    authors = {}
    for wrap in WRAP_TAGS:
        for w in el.iter(W_ + wrap):
            a = author_of(w) or "?"
            authors[a] = authors.get(a, 0) + 1
    return authors


def collect_paragraphs(unpacked_dir):
    """[(part_relpath, w:p element, tree)] in document order."""
    paragraphs = []
    parts = parts_with_root(Path(unpacked_dir))
    parts.sort(key=lambda rp: (rp[0] != "word/document.xml", rp[0]))
    for rel, path in parts:
        tree = etree.parse(str(path))
        for p in tree.getroot().iter(W_ + "p"):
            paragraphs.append((rel, p, tree))
    return paragraphs


# ---------------------------------------------------------------------------
# Low-level builders
# ---------------------------------------------------------------------------

def ensure_xmlspace(t_elem, text):
    if text[:1].isspace() or text[-1:].isspace():
        t_elem.set(XML_SPACE, "preserve")
    else:
        t_elem.attrib.pop(XML_SPACE, None)


def make_run_with_text(rpr_xml, text, deltext=False):
    r = etree.Element(W_ + "r")
    if rpr_xml is not None:
        r.append(deepcopy(rpr_xml))
    t = etree.SubElement(r, W_ + ("delText" if deltext else "t"))
    t.text = text
    ensure_xmlspace(t, text)
    return r


def make_wrap(tag_name, author, rid, runs):
    wrap = etree.Element(W_ + tag_name)
    wrap.set(W_ + "id", str(rid))
    wrap.set(W_ + "author", author)
    wrap.set(W_ + "date", _now_iso())
    for r in runs:
        wrap.append(r)
    return wrap


def run_nontext(run):
    return [c for c in run if not (lname(c, "rPr") or lname(c, "t") or lname(c, "delText"))]


def clone_run_with_subtext(run, text, deltext=False):
    new_run = deepcopy(run)
    for c in list(new_run):
        if lname(c, "t") or lname(c, "delText"):
            new_run.remove(c)
    t = etree.SubElement(new_run, W_ + ("delText" if deltext else "t"))
    t.text = text
    ensure_xmlspace(t, text)
    return new_run


def split_run_for_del(run, prefix, deleted, suffix, author, rid):
    """[before_run?, del_wrap, after_run?] to splice at the run's parent position."""
    result = []
    if prefix or run_nontext(run):
        result.append(clone_run_with_subtext(run, prefix))
    del_run = make_run_with_text(child(run, "rPr"), deleted, deltext=True)
    result.append(make_wrap("del", author, rid, [del_run]))
    if suffix or run_nontext(run):
        result.append(clone_run_with_subtext(run, suffix))
    return result


def splice_children_at(parent, el, replacements):
    pos = list(parent).index(el)
    for i, repl in enumerate(replacements):
        parent.insert(pos + i, repl)
    parent.remove(el)


def normalize_runs(p_elem):
    for run in p_elem.iter(W_ + "r"):
        for attr_name, text_elem in (("t", "t"), ("delText", "delText")):
            elems = children(run, text_elem)
            if len(elems) > 1:
                text = "".join(t.text or "" for t in elems)
                for t in elems[1:]:
                    run.remove(t)
                elems[0].text = text
                ensure_xmlspace(elems[0], text)


# ---------------------------------------------------------------------------
# Apply engine
# ---------------------------------------------------------------------------

class ApplyState:
    def __init__(self, parts_paths, author):
        self.author = author
        self.next_id = max_w_id(parts_paths) + 1
        self.edits_applied = 0
        self.paragraph_deleted = 0


def max_w_id(parts_paths):
    m = 0
    for _, path in parts_paths:
        try:
            root = etree.parse(str(path)).getroot()
            for el in root.iter():
                v = el.get(W_ + "id")
                if v and v.isdigit():
                    m = max(m, int(v))
        except etree.XMLSyntaxError:
            continue
    return m


def remove_element_recursively(el):
    """Remove el, then its ancestors while they become empty (own-ins supersede)."""
    while el is not None and len(el) == 0:
        parent = el.getparent()
        if parent is None:
            return
        parent.remove(el)
        el = parent


def delete_span_in_paragraph(p_elem, s, e, state):
    items = build_items(p_elem)
    groups = []
    offset = 0
    for item in items:
        if not item.contributes_to_visible():
            continue
        length = len(item.text)
        lo = max(s, offset)
        hi = min(e, offset + length)
        if lo < hi:
            groups.append((item, lo - offset, hi - offset))
        offset += length

    for item, lo, hi in groups:
        text = item.text
        prefix, deleted, suffix = text[:lo], text[lo:hi], text[hi:]
        inn = item.innermost
        run_parent = item.run.getparent()
        if run_parent is None:
            continue

        if inn is None:
            # normal run -> del-wrap + ins later, at run's parent level
            splice_children_at(
                run_parent, item.run,
                split_run_for_del(item.run, prefix, deleted, suffix,
                                  state.author, state.next_id))
            state.next_id += 1
        elif WRAP_KIND[inn[0]] == "ins" and inn[1] == state.author:
            # our own prior insertion -> supersede
            if lo == 0 and hi == len(text):
                # whole item superseded: drop it; new text (if any) is inserted by caller
                item.elem.text = ""
                remove_element_recursively(item.elem)
            else:
                item.elem.text = prefix + suffix
                ensure_xmlspace(item.elem, prefix + suffix)
        elif WRAP_KIND[inn[0]] == "ins":
            # another author's insertion -> nest OUR del inside their w:ins
            splice_children_at(
                run_parent, item.run,
                split_run_for_del(item.run, prefix, deleted, suffix,
                                  state.author, state.next_id))
            state.next_id += 1
        # else: text inside a deletion - not visible, ignore (cannot happen)


def unwrap_del(d_el):
    """Restore deleted text: turn a w:del into plain runs (delText -> t)."""
    parent = d_el.getparent()
    if parent is None:
        return
    for dt in list(d_el.iter(W_ + "delText")):
        dt.tag = W_ + "t"
        ensure_xmlspace(dt, dt.text or "")
    idx = list(parent).index(d_el)
    for child in list(d_el):
        parent.insert(idx, child)
        idx += 1
    parent.remove(d_el)


def insert_text_at(p_elem, pos, new_text, state):
    if not new_text:
        return
    items = build_items(p_elem)
    visible = visible_text(items)
    ppr = child(p_elem, "pPr")

    if not visible:
        rpr = child(ppr, "rPr") if ppr is not None else None
        ins = make_wrap("ins", state.author, state.next_id,
                        [make_run_with_text(rpr, new_text)])
        state.next_id += 1
        p_elem.insert(1 if ppr is not None else 0, ins)
        return

    # undo-own-del: insertion restores text we ourselves deleted last round
    if pos == 0:
        first = (ppr.getnext() if ppr is not None else p_elem[0]) if len(p_elem) else None
        if first is not None and (lname(first, "del") or lname(first, "moveFrom")) \
                and author_of(first) == state.author:
            deltext = "".join(dt.text or "" for dt in first.iter(W_ + "delText"))
            if deltext == new_text:
                unwrap_del(first)
                return
    else:
        anchor = item_at_visible_pos(items, pos - 1)
        if anchor is not None and _restore_own_del(anchor, new_text, state.author):
            return

    if pos == 0:
        ins = make_wrap("ins", state.author, state.next_id,
                        [make_run_with_text(None, new_text)])
        state.next_id += 1
        p_elem.insert(1 if ppr is not None else 0, ins)
        return

    anchor = item_at_visible_pos(items, pos - 1) or item_at_visible_pos(items, 0)
    rpr = anchor.rpr

    # restoring deleted text: undo our own del, or place our ins AFTER another's del
    nxt = anchor.top.getnext()
    if nxt is not None and (lname(nxt, "del") or lname(nxt, "moveFrom")):
        nxttext = "".join(dt.text or "" for dt in nxt.iter(W_ + "delText"))
        if nxttext == new_text:
            if author_of(nxt) == state.author:
                unwrap_del(nxt)
            else:
                ins = make_wrap("ins", state.author, state.next_id,
                                [make_run_with_text(rpr, new_text)])
                state.next_id += 1
                nxt.addnext(ins)
            return

    own_ins = anchor.in_wrap("ins", state.author)
    if own_ins is not None:
        own_ins.append(make_wrap("ins", state.author, state.next_id,
                                 [make_run_with_text(rpr, new_text)]))
        state.next_id += 1
        return

    ins = make_wrap("ins", state.author, state.next_id, [make_run_with_text(rpr, new_text)])
    state.next_id += 1
    anchor.top.addnext(ins)


def _restore_own_del(anchor, text, author):
    if anchor.innermost is not None and WRAP_KIND[anchor.innermost[0]] == "ins":
        return False
    prev = anchor.top.getprevious()
    if prev is None:
        return False
    if not (lname(prev, "del") or lname(prev, "moveFrom")):
        return False
    if author_of(prev) != author:
        return False
    deltext = "".join(dt.text or "" for dt in prev.iter(W_ + "delText"))
    if deltext != text:
        return False
    unwrap_del(prev)
    return True


def delete_paragraph_mark(p_elem, state):
    ppr = child(p_elem, "pPr")
    if ppr is None:
        ppr = etree.Element(W_ + "pPr")
        p_elem.insert(0, ppr)
    rpr = child(ppr, "rPr")
    if rpr is None:
        rpr = etree.SubElement(ppr, W_ + "rPr")
    else:
        for d in children(rpr, "del"):
            rpr.remove(d)
    d = etree.Element(W_ + "del")
    d.set(W_ + "id", str(state.next_id))
    d.set(W_ + "author", state.author)
    d.set(W_ + "date", _now_iso())
    state.next_id += 1
    rpr.append(d)
    state.paragraph_deleted += 1


def apply_edit_to_paragraph(p_elem, old, new, state, all_occurrences):
    """Apply one edit to one paragraph. Returns n occurrences, or None if old not found."""
    normalize_runs(p_elem)
    visible = visible_text(build_items(p_elem))

    if old is None:
        old = visible
    if old == "":
        # insertion into an empty paragraph (or pure prepend of whole-para replace)
        if new and visible == "":
            insert_text_at(p_elem, 0, new, state)
            return 1
        if new and visible:
            old = visible
        elif not new:
            return 0
    if old == new:
        return 0

    occurrences = []
    start = 0
    while True:
        idx = visible.find(old, start)
        if idx < 0:
            break
        occurrences.append((idx, idx + len(old)))
        if not all_occurrences:
            break
        start = idx + len(old)
    if not occurrences:
        return None

    for s, e in reversed(occurrences):
        delete_span_in_paragraph(p_elem, s, e, state)
        insert_text_at(p_elem, s, new, state)

    items = build_items(p_elem)
    if new == "" and visible == old and not any(i.contributes_to_visible() for i in items):
        delete_paragraph_mark(p_elem, state)

    return len(occurrences)


def clean_paragraph(p_elem):
    changed = True
    while changed:
        changed = False
        for wrap in WRAP_TAGS:
            for w in list(p_elem.iter(W_ + wrap)):
                parent = w.getparent()
                if parent is None:
                    continue
                if lname(parent, "rPr"):
                    continue  # paragraph-mark deletion (deliberately empty)
                if len(w) == 0:
                    parent.remove(w)
                    changed = True
        for run in list(p_elem.iter(W_ + "r")):
            if len(run) == 0:
                parent = run.getparent()
                if parent is not None:
                    parent.remove(run)
                    changed = True


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def parts_with_root(root):
    result = []
    for p in sorted(Path(root).rglob("*.xml")):
        rel = p.relative_to(root).as_posix()
        if not rel.startswith("word/"):
            continue
        try:
            etree.parse(str(p))
        except etree.XMLSyntaxError:
            continue
        result.append((rel, p))
    return result


def cmd_unpack(args):
    src = Path(args.input)
    out = Path(args.output)
    if not src.exists():
        print(f"ERROR: {args.input} does not exist")
        sys.exit(1)
    if src.suffix.lower() != ".docx":
        print(f"ERROR: {args.input} must be a .docx file (convert .doc first)")
        sys.exit(1)
    try:
        out.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(str(src), "r") as zf:
            zf.extractall(str(out))
    except zipfile.BadZipFile:
        print(f"ERROR: {args.input} is not a valid DOCX")
        sys.exit(1)
    n = 0
    for _, path in parts_with_root(out):
        parser = etree.XMLParser(remove_blank_text=True)
        tree = etree.parse(str(path), parser)
        tree.write(str(path), xml_declaration=True, encoding="UTF-8", pretty_print=True)
        n += 1
    print(f"Unpacked {args.input} -> {args.output} ({n} XML parts)")


def cmd_status(args):
    paragraphs = collect_paragraphs(args.unpacked)
    for i, (rel, p_elem, _tree) in enumerate(paragraphs):
        if args.para is not None and i != args.para:
            continue
        text = visible_text(build_items(p_elem))
        auth = redline_authors_in(p_elem)
        red = ", ".join(f"{a}×{n}" for a, n in sorted(auth.items()))
        shown = text if not args.limit or len(text) <= args.limit else text[: args.limit] + "…"
        part = "" if rel == "word/document.xml" else f" [{rel}]"
        print(f"[{i}] {shown!r}" + (f"  | redlines: {red}" if red else "") + part)
        if args.para is not None:
            return
    print(f"(total paragraphs: {len(paragraphs)})")


def cmd_summary(args):
    parts = parts_with_root(Path(args.unpacked))
    authors = {}
    wraps = {}
    for _, path in parts:
        root = etree.parse(str(path)).getroot()
        for wtag in WRAP_TAGS:
            n = len(list(root.iter(W_ + wtag)))
            if n:
                wraps[wtag] = wraps.get(wtag, 0) + n
        for a, n in redline_authors_in(root).items():
            authors[a] = authors.get(a, 0) + n
    print("Tracked-change wrappers:", wraps or "none")
    if authors:
        print("Authors present:", ", ".join(f"{a}={n}" for a, n in sorted(authors.items())))
    else:
        print("No tracked changes in document.")


def cmd_apply(args):
    state = ApplyState(parts_with_root(Path(args.unpacked)), args.author)

    if args.old is not None:
        edits = [{"old": args.old, "new": args.new, "all": args.all}]
    else:
        edits = json.loads(Path(args.edits).read_text(encoding="utf-8"))

    paragraphs = collect_paragraphs(args.unpacked)
    total = 0
    for edit in edits:
        old = edit.get("old")
        new = edit.get("new", "")
        all_occ = bool(edit.get("all"))
        para_idx = edit.get("para")

        if para_idx is not None:
            if not (0 <= para_idx < len(paragraphs)):
                print(f"ERROR: para {para_idx} out of range (0..{len(paragraphs) - 1})")
                sys.exit(1)
            rel, p_elem, tree = paragraphs[para_idx]
            n = apply_edit_to_paragraph(p_elem, old, new, state, all_occ)
            if n is None:
                if old is not None:
                    print(f"ERROR: para {para_idx}: text not found: {old!r}")
                    sys.exit(1)
                n = 0
            total += n
            if n:
                clean_paragraph(p_elem)
                _write_tree(tree, Path(args.unpacked), rel)
        else:
            applied = False
            for rel, p_elem, tree in paragraphs:
                n = apply_edit_to_paragraph(p_elem, old, new, state, all_occ)
                if n is not None:
                    total += n
                    applied = True
                    clean_paragraph(p_elem)
                    _write_tree(tree, Path(args.unpacked), rel)
                    if not all_occ:
                        break
            if not applied:
                print(f"ERROR: text not found anywhere: {old!r}")
                sys.exit(1)

    print(f"Applied {total} tracked-change edit(s)"
          + (f", deleted {state.paragraph_deleted} paragraph mark(s)" if state.paragraph_deleted else ""))


def _write_tree(tree, unpacked_dir, rel):
    tree.write(str(Path(unpacked_dir) / rel), xml_declaration=True,
               encoding="UTF-8", pretty_print=True)


def condense_xml(path):
    parser = etree.XMLParser(remove_blank_text=True)
    tree = etree.parse(str(path), parser)
    tree.write(str(path), xml_declaration=True, encoding="UTF-8", pretty_print=False)


def cmd_pack(args):
    src = Path(args.unpacked)
    out = Path(args.output)
    if args.original:
        ok, msg = verify_dirs(src, Path(args.original), args.author)
        if not ok:
            print("VERIFY FAILED - refusing to pack.")
            print(msg)
            sys.exit(1)
    for _, path in parts_with_root(src):
        condense_xml(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(str(out), "w", zipfile.ZIP_DEFLATED) as zf:
        for f in src.rglob("*"):
            if f.is_file():
                zf.write(str(f), f.relative_to(src).as_posix())
    print(f"Packed {src} -> {out}")


def strip_author_changes(root, author):
    for ins in list(root.iter(W_ + "ins")) + list(root.iter(W_ + "moveTo")):
        if author_of(ins) == author and ins.getparent() is not None:
            ins.getparent().remove(ins)
    for d in list(root.iter(W_ + "del")) + list(root.iter(W_ + "moveFrom")):
        if author_of(d) != author:
            continue
        parent = d.getparent()
        if parent is None:
            continue
        for dt in list(d.iter(W_ + "delText")):
            dt.tag = W_ + "t"
        idx = list(parent).index(d)
        for child in list(d):
            parent.insert(idx, child)
            idx += 1
        parent.remove(d)


def extract_text(root):
    lines = []
    for p in root.iter(W_ + "p"):
        lines.append("".join(t.text or "" for t in p.iter(W_ + "t")))
    return "\n".join(lines)


def verify_dirs(unpacked_dir, original_docx, author, verbose=True):
    try:
        with zipfile.ZipFile(str(original_docx), "r") as zf:
            orig = etree.fromstring(zf.read("word/document.xml"))
    except (KeyError, zipfile.BadZipFile) as e:
        return False, f"ERROR: cannot read original {original_docx}: {e}"

    mod_path = Path(unpacked_dir) / "word" / "document.xml"
    if not mod_path.exists():
        return False, "ERROR: word/document.xml not found in unpacked dir"
    try:
        mod = etree.parse(str(mod_path)).getroot()
    except etree.XMLSyntaxError as e:
        return False, f"ERROR: modified XML malformed: {e}"

    strip_author_changes(orig, author)
    strip_author_changes(mod, author)

    t1 = extract_text(orig)
    t2 = extract_text(mod)
    if t1 == t2:
        if verbose:
            print(f"PASSED - after removing {author}'s changes the text matches the original.")
        return True, "PASSED"
    if verbose:
        print(f"FAILED - after removing {author}'s changes the text DIFFERS from original.")
        for line in list(difflib.unified_diff(t1.splitlines(), t2.splitlines(),
                                              lineterm=""))[:60]:
            print(line)
    return False, "FAILED"


def cmd_verify(args):
    ok, _ = verify_dirs(Path(args.unpacked), Path(args.original), args.author)
    sys.exit(0 if ok else 1)


def accept_author_changes(root, author):
    """Accept `author`'s changes: unwrap their ins (keep as plain text), drop their del."""
    for ins in list(root.iter(W_ + "ins")) + list(root.iter(W_ + "moveTo")):
        if author_of(ins) != author:
            continue
        parent = ins.getparent()
        if parent is None:
            continue
        idx = list(parent).index(ins)
        for child in list(ins):
            parent.insert(idx, child)
            idx += 1
        parent.remove(ins)
    for d in list(root.iter(W_ + "del")) + list(root.iter(W_ + "moveFrom")):
        if author_of(d) == author and d.getparent() is not None:
            d.getparent().remove(d)


def cmd_fold(args):
    src = Path(args.unpacked)
    for _, path in parts_with_root(src):
        tree = etree.parse(str(path))
        accept_author_changes(tree.getroot(), args.author)
        tree.write(str(path), xml_declaration=True, encoding="UTF-8", pretty_print=False)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(str(out), "w", zipfile.ZIP_DEFLATED) as zf:
        for f in src.rglob("*"):
            if f.is_file():
                zf.write(str(f), f.relative_to(src).as_posix())
    print(f"Accepted {args.author}'s changes -> {out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("unpack", help="extract + pretty-print a docx for editing")
    p.add_argument("input")
    p.add_argument("output")
    p.set_defaults(func=cmd_unpack)

    p = sub.add_parser("status", help="dump paragraphs with visible text")
    p.add_argument("unpacked")
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--para", type=int)
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("summary", help="redline usage report")
    p.add_argument("unpacked")
    p.set_defaults(func=cmd_summary)

    p = sub.add_parser("apply", help="apply tracked-change edits")
    p.add_argument("unpacked")
    p.add_argument("--edits")
    p.add_argument("--old")
    p.add_argument("--new", default="")
    p.add_argument("--all", action="store_true")
    p.add_argument("--author", default="sculab")
    p.set_defaults(func=cmd_apply)

    p = sub.add_parser("pack", help="repack unpacked dir into a docx")
    p.add_argument("unpacked")
    p.add_argument("output")
    p.add_argument("--original")
    p.add_argument("--author", default="sculab")
    p.set_defaults(func=cmd_pack)

    p = sub.add_parser("verify", help="author-strip consistency check")
    p.add_argument("unpacked")
    p.add_argument("--original", required=True)
    p.add_argument("--author", default="sculab")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("fold", help="accept one author's changes into a clean docx")
    p.add_argument("unpacked")
    p.add_argument("--author", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_fold)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
