#!/usr/bin/env python3
"""Regression tests for the redline-aware revision engine (revise.py).

Run:  python3 tests/revise_tests.py
"""

import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from lxml import etree

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import revise as R  # noqa: E402

W = R.W_


def make_doc(paras_xml, dest):
    """Build a minimal docx whose body has the given list of w:p elements."""
    etree.register_namespace("w", R.W)
    doc = etree.Element(R.tag("document"), nsmap={"w": R.W})
    body = etree.SubElement(doc, R.tag("body"))
    for p in paras_xml:
        body.append(p)
    sect = etree.Element(R.tag("sectPr"))
    sect.append(etree.Element(R.tag("pgSz")))
    body.append(sect)

    tmp = Path(dest)
    (tmp / "word").mkdir(parents=True, exist_ok=True)
    (tmp / "_rels").mkdir(parents=True, exist_ok=True)
    (tmp / "word" / "_rels").mkdir(parents=True, exist_ok=True)
    (tmp / "docProps").mkdir(parents=True, exist_ok=True)
    (tmp / "customXml").mkdir(parents=True, exist_ok=True)
    tree = etree.ElementTree(doc)
    tree.write(str(tmp / "word" / "document.xml"),
               xml_declaration=True, encoding="UTF-8", pretty_print=True)
    (tmp / "[Content_Types].xml").write_text(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/'
        'package/2006/content-types"><Default Extension="rels" ContentType='
        '"application/vnd.openxmlformats-package.relationships+xml"/><Default '
        'Extension="xml" ContentType="application/xml"/><Override PartName="/word/'
        'document.xml" ContentType="application/vnd.openxmlformats-officedocument'
        '.wordprocessingml.document.main+xml"/></Types>')
    (tmp / "_rels" / ".rels").write_text(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats'
        '.org/package/2006/relationships"><Relationship Id="rId1" Type="http://'
        'schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"'
        ' Target="word/document.xml"/></Relationships>')
    (tmp / "word" / "_rels" / "document.xml.rels").write_text(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats'
        '.org/package/2006/relationships"></Relationships>')
    out = dest + ".docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in tmp.rglob("*"):
            if f.is_file():
                zf.write(str(f), f.relative_to(tmp).as_posix())
    return out


def p_runs(*children):
    p = etree.Element(R.tag("p"))
    for c in children:
        p.append(c)
    return p


def run(text, deltext=False):
    r = etree.Element(R.tag("r"))
    t = etree.SubElement(r, R.tag("delText" if deltext else "t"))
    t.text = text
    return r


def wrap(tag, author, rid, *children):
    w = etree.Element(R.tag(tag))
    w.set(R.W_ + "id", str(rid))
    w.set(R.W_ + "author", author)
    w.set(R.W_ + "date", "2026-07-01T00:00:00Z")
    for c in children:
        w.append(c)
    return w


def unpacked_paths(out_docx):
    tmp = tempfile.mkdtemp()
    with zipfile.ZipFile(out_docx) as zf:
        zf.extractall(tmp)
    return Path(tmp)


def apply_edits(docx_path, edits, author="sculab"):
    workdir = unpacked_paths(docx_path)
    for e in edits:
        paras = R.collect_paragraphs(workdir)
        if e.get("para") is not None:
            rel, p, tree = paras[e["para"]]
            n = R.apply_edit_to_paragraph(p, e.get("old"), e.get("new", ""),
                                          R.ApplyState([(rel, workdir / rel)], author),
                                          bool(e.get("all")))
            if n is None:
                raise AssertionError(f"text not found: {e.get('old')!r}")
            R.clean_paragraph(p)
            tree.write(str(workdir / rel), xml_declaration=True, encoding="UTF-8",
                       pretty_print=True)
        else:
            done = False
            for rel, p, tree in R.collect_paragraphs(workdir):
                n = R.apply_edit_to_paragraph(p, e.get("old"), e.get("new", ""),
                                              R.ApplyState([(rel, workdir / rel)], author),
                                              bool(e.get("all")))
                if n is not None:
                    done = True
                    R.clean_paragraph(p)
                    tree.write(str(workdir / rel), xml_declaration=True, encoding="UTF-8",
                               pretty_print=True)
                    if not e.get("all"):
                        break
            if not done:
                raise AssertionError(f"text not found anywhere: {e.get('old')!r}")
    return workdir


def para_texts(workdir):
    root = etree.parse(str(workdir / "word" / "document.xml")).getroot()
    return [R.visible_text(R.build_items(p)) for p in root.iter(R.W_ + "p")]


class TestEngine(unittest.TestCase):

    def test_round1_round2(self):
        d = make_doc([p_runs(run("这是第一段测试文本，包含一些内容。")),
                      p_runs(run("四川省重点实验室建设申报书"))],
                     tempfile.mktemp(suffix="_r1"))
        w1 = apply_edits(d, [
            {"para": 0, "old": "包含一些内容", "new": "包含丰富内容"},
            {"para": 1, "old": "四川省重点实验室", "new": "四川省重点实验室（筹）"},
        ])
        self.assertEqual(para_texts(w1),
                         ["这是第一段测试文本，包含丰富内容。",
                          "四川省重点实验室（筹）建设申报书"])
        # verify invariant: stripping sculab changes restores original
        ok, _ = R.verify_dirs(w1, d, "sculab", verbose=False)
        self.assertTrue(ok)

        # round 2: change text that now lives inside sculab's own ins + normal run
        # repack round-1 output first
        out1 = tempfile.mktemp(suffix="_r2.docx")
        with zipfile.ZipFile(out1, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in w1.rglob("*"):
                if f.is_file():
                    zf.write(str(f), f.relative_to(w1).as_posix())
        w2 = apply_edits(out1, [{"para": 0, "old": "包含丰富内容", "new": "包含大量信息"}])
        self.assertEqual(para_texts(w2),
                         ["这是第一段测试文本，包含大量信息。",
                          "四川省重点实验室（筹）建设申报书"])
        ok, _ = R.verify_dirs(w2, d, "sculab", verbose=False)
        self.assertTrue(ok)

    def test_other_author_redlines_preserved(self):
        # Jane deleted 5 / inserted 10 in para 2; sculab then revises around it
        d = make_doc([
            p_runs(run("该设施于2020年建成投用。")),
            p_runs(run("每年开放交流不少于"), wrap("del", "Jane", 1, run("5", True)),
                   wrap("ins", "Jane", 2, run("10")), run("次。")),
        ], tempfile.mktemp(suffix="_jane"))

        w = apply_edits(d, [{"para": 1, "old": "每年开放交流不少于10次",
                             "new": "每年开放交流不少于8次"}])
        self.assertEqual(para_texts(w), ["该设施于2020年建成投用。",
                                         "每年开放交流不少于8次。"])

        root = etree.parse(str(w / "word" / "document.xml")).getroot()
        jane_dels = [x for x in root.iter(W + "del") if x.get(W + "author") == "Jane"]
        jane_inss = [x for x in root.iter(W + "ins") if x.get(W + "author") == "Jane"]
        self.assertEqual(len(jane_dels), 1)
        self.assertEqual(len(jane_inss), 1)
        # sculab's del must be nested inside Jane's ins
        nested = [x for x in root.iter(W + "del") if x.get(W + "author") == "sculab"
                  and x.getparent() is not None and x.getparent().tag == W + "ins"]
        self.assertEqual(len(nested), 1)
        # invariant
        ok, _ = R.verify_dirs(w, d, "sculab", verbose=False)
        self.assertTrue(ok)

    def test_whole_paragraph_delete(self):
        d = make_doc([p_runs(run("第一段。")), p_runs(run("要删除的整段内容。")),
                      p_runs(run("第三段。"))], tempfile.mktemp(suffix="_del"))
        w = apply_edits(d, [{"para": 1, "new": ""}])
        self.assertEqual(para_texts(w), ["第一段。", "", "第三段。"])
        root = etree.parse(str(w / "word" / "document.xml")).getroot()
        paras = list(root.iter(W + "p"))
        mark_del = paras[1].find(f"{W}pPr/{W}rPr/{W}del")
        self.assertIsNotNone(mark_del)
        ok, _ = R.verify_dirs(w, d, "sculab", verbose=False)
        self.assertTrue(ok)

    def test_undo_own_changes(self):
        d = make_doc([p_runs(run("abc def ghi"))], tempfile.mktemp(suffix="_undo"))
        w1 = apply_edits(d, [{"para": 0, "old": "def", "new": "XYZ"}])
        self.assertEqual(para_texts(w1), ["abc XYZ ghi"])
        # round 2: revert XYZ back to def -> should restore original cleanly
        out1 = tempfile.mktemp(suffix="_u.docx")
        with zipfile.ZipFile(out1, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in w1.rglob("*"):
                if f.is_file():
                    zf.write(str(f), f.relative_to(w1).as_posix())
        w2 = apply_edits(out1, [{"para": 0, "old": "XYZ", "new": "def"}])
        self.assertEqual(para_texts(w2), ["abc def ghi"])
        # no redlines should remain (own changes fully reverted)
        root = etree.parse(str(w2 / "word" / "document.xml")).getroot()
        self.assertEqual(len(list(root.iter(W + "ins"))), 0)
        self.assertEqual(len(list(root.iter(W + "del"))), 0)
        ok, _ = R.verify_dirs(w2, d, "sculab", verbose=False)
        self.assertTrue(ok)

    def test_insert_into_empty_paragraph(self):
        d = make_doc([p_runs(run("前置。")), p_runs(run("")), p_runs(run("后置。"))],
                     tempfile.mktemp(suffix="_emp"))
        w = apply_edits(d, [{"para": 1, "old": "", "new": "新增内容"}])
        self.assertEqual(para_texts(w), ["前置。", "新增内容", "后置。"])

    def test_revise_own_ins_again_no_duplicate(self):
        # round1: some->rich; round2: rich->info; round3: info->news
        d = make_doc([p_runs(run("包含一些内容"))], tempfile.mktemp(suffix="_dup"))
        out = d
        for old, new in (("包含一些内容", "包含丰富内容"),
                         ("包含丰富内容", "包含信息"),
                         ("包含信息", "包含新内容")):
            w = apply_edits(out, [{"para": 0, "old": old, "new": new}])
            self.assertEqual(para_texts(w), [new])
            out = tempfile.mktemp(suffix="_n.docx")
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in w.rglob("*"):
                    if f.is_file():
                        zf.write(str(f), f.relative_to(w).as_posix())
            ok, _ = R.verify_dirs(w, d, "sculab", verbose=False)
            self.assertTrue(ok)
        # exactly one ins + one del should remain
        root = etree.parse(str(w / "word" / "document.xml")).getroot()
        self.assertEqual(len(list(root.iter(W + "ins"))), 1)
        self.assertEqual(len(list(root.iter(W + "del"))), 1)

    def test_fold_accepts_own_changes(self):
        d = make_doc([p_runs(run("abc def ghi"))], tempfile.mktemp(suffix="_fld"))
        w = apply_edits(d, [{"para": 0, "old": "def", "new": "XYZ"}])
        folddir = Path(tempfile.mkdtemp())
        (folddir / "word").mkdir()
        import shutil
        shutil.copy(w / "word" / "document.xml", folddir / "word" / "document.xml")
        root = etree.parse(str(folddir / "word" / "document.xml")).getroot()
        R.accept_author_changes(root, "sculab")
        texts = [R.visible_text(R.build_items(p)) for p in root.iter(W + "p")]
        self.assertEqual(texts, ["abc XYZ ghi"])
        self.assertEqual(len(list(root.iter(W + "ins"))), 0)
        self.assertEqual(len(list(root.iter(W + "del"))), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
