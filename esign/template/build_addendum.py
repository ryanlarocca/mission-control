#!/usr/bin/env python3
"""
Build an LRG Homes addendum to the Real Estate Purchase & Sale Agreement.

    python3 esign/template/build_addendum.py SPEC.json OUT.pdf

Ryan's standard addendum (2026-11-17, first used for 261 Bieber Dr Addendum
No. 2). One letter page in the Addendum No. 1 look: the title, a boxed header
(agreement date / property / seller / buyer / escrow), the "these terms
control" lead-in, the numbered terms, then the signature blocks on the
purchase agreement template's page-2 geometry (build_template.py) plus a
second buyer line, so e-sign signs it like the agreement: first Buyer on the
buyer line, second Buyer on the buyer2 line, first Seller on the seller line,
anyone else on e-sign's generated Signature Addendum (box ticked). A hidden
`addendum_form` field marks it so e-sign accepts one page and keeps it off
the lead card (esign/lib/pdf.mjs inspectPdf, lib/crm.mjs).

SPEC.json:
  {
    "number": 2,
    "agreement_date": "November 6, 2026",
    "property": "261 Bieber Dr, San Jose, CA 95123",
    "seller": "Barbara A. Varnell, Trustee of the Barbara A. Varnell Trust",
    "buyer": "LRG Homes, LLC",
    "escrow": "Chicago Title Company, Escrow No. 3021265162",      (optional)
    "terms": [["Heading.", "Body text. **bold** runs allowed."], ...],
    "buyer_signer": "LRG Homes, LLC, by Ryan LaRocca, Authorized Representative",
    "buyer2_signer": "Charity Doors LLC, by Adam Oback, Member",            (optional)
    "seller_signer": "Barbara A. Varnell, Trustee of the Barbara A. Varnell Trust"
  }

A term body may contain blank-line paragraphs ("\\n\\n"); each continues at the
term's indent.
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reportlab.pdfbase.pdfmetrics import stringWidth  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402

from build_template import (  # noqa: E402
    BODY, BOLD, BUYER_BLOCK_Y, BUYER_LINE_Y, BUYER2_BLOCK_Y, BUYER2_LINE_Y, CHECKBOX_RECT, FIELD_DROP, FIELD_H, INDENT, ITAL,
    LABEL_X, LEFT, REG, RIGHT, SELLER_BLOCK_Y, SELLER_LINE_Y, SIG_X0, SIG_X1, VALUE_X, W, H,
    Page, add_form, tokens, wrap,
)

SIZE = 9.0        # body size (the agreement uses 9.4; an addendum has to fit one page)
LEAD = 11.0
GAP = 4.0
TITLE_SIZE = 14.0
BOX_ROW = 14.5    # header box row height
BOX_LABEL_X = LEFT + 26.0
BOX_VALUE_X = LEFT + 160.0
BOX_X0, BOX_X1 = LEFT + 20.0, RIGHT - 20.0
TERMS_FLOOR = 322.0   # the lowest baseline the terms may use; the signature blocks start below it
NAME_SIZE = 8.2


class AddendumPage(Page):
    def __init__(self, c, footer_left):
        super().__init__(c, 1)
        self.footer_left = footer_left

    def footer(self):
        c = self.c
        c.setFillColorRGB(0.5, 0.5, 0.5)
        self.text(LEFT, 30.0, self.footer_left, REG, 7.5)
        s = "Page 1 of 1"
        self.text(RIGHT - stringWidth(s, REG, 7.5), 30.0, s, REG, 7.5)
        c.setFillColorRGB(0, 0, 0)


def lines_of(toks, x_first, x_cont, x_max=RIGHT, size=SIZE):
    return wrap(toks, x_first, x_cont, x_max, size)


def build(spec):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(W, H))
    c.setTitle(f"Addendum No. {spec['number']} - {spec['property']}")
    p = AddendumPage(c, f"Addendum No. {spec['number']}  |  {spec['property']}")

    p.centered(748.0, f"ADDENDUM NO. {spec['number']}", REG, TITLE_SIZE)
    p.centered(735.0, "to Real Estate Purchase & Sale Agreement", REG, 8.5)

    rows = [("Purchase Agreement dated:", spec["agreement_date"]),
            ("Property:", spec["property"]),
            ("Seller:", spec["seller"]),
            ("Buyer:", spec["buyer"])]
    if spec.get("escrow"):
        rows.append(("Escrow:", spec["escrow"]))
    top = 722.0
    bottom = top - BOX_ROW * len(rows)
    c.setLineWidth(0.8)
    c.rect(BOX_X0, bottom, BOX_X1 - BOX_X0, top - bottom, stroke=1, fill=0)
    c.setLineWidth(0.4)
    for i, (label, value) in enumerate(rows):
        y_top = top - BOX_ROW * i
        if i:
            c.line(BOX_X0, y_top, BOX_X1, y_top)
        base = y_top - BOX_ROW + 4.5
        p.text(BOX_LABEL_X, base, label, REG, SIZE)
        p.text(BOX_VALUE_X, base, value, REG, SIZE)

    y = bottom - 18.0
    for line in lines_of(tokens("The following terms are added to and made part of the Agreement. Where these terms "
                                "conflict with the Agreement, these terms control."), LEFT, LEFT):
        p.draw_line(line, y, SIZE)
        y -= LEAD
    y -= GAP

    for n, (heading, body) in enumerate(spec["terms"], 1):
        paras = body.split("\n\n")
        first = [("text", f"{n}.", REG, None), ("text", heading, BOLD, None)] + tokens(paras[0])
        for line in lines_of(first, LEFT, INDENT):
            p.draw_line(line, y, SIZE)
            y -= LEAD
        for para in paras[1:]:
            y -= 2.0
            for line in lines_of(tokens(para), INDENT, INDENT):
                p.draw_line(line, y, SIZE)
                y -= LEAD
        y -= GAP

    y -= 2.0
    for line in lines_of(tokens("All other terms and conditions of the Agreement remain unchanged and in full force "
                                "and effect."), LEFT, LEFT):
        p.draw_line(line, y, SIZE)
        y -= LEAD
    last = y + LEAD
    assert last >= TERMS_FLOOR, f"the terms run into the signature blocks (last baseline {last:.1f} < {TERMS_FLOOR}); shorten them"

    # ---- signature blocks on the purchase agreement's page-2 geometry (esign/lib/pdf.mjs TEMPLATE)
    c.setLineWidth(0.6)
    c.setStrokeColorRGB(0, 0, 0)

    def block(block_y, line_y, label, date_name, who):
        p.text(LEFT, block_y, "Dated:", REG, SIZE)
        r = (88.0, block_y - FIELD_DROP, 198.0, block_y - FIELD_DROP + FIELD_H)
        p.field_box(r[0], r[1], r[2] - r[0], FIELD_H)
        p.fields.append({"name": date_name, "rect": r, "multiline": False})
        p.text(LABEL_X, block_y, label, REG, SIZE)
        c.line(SIG_X0, line_y, SIG_X1, line_y)
        p.text(SIG_X0 + 2, line_y - 8.0, "Signature", ITAL, 7)
        if who:  # printed name in the left column, so the next signature up can't run into it
            yy = block_y - 13.0
            for line in lines_of(tokens(who), LEFT, LEFT, LABEL_X - 10.0, NAME_SIZE):
                p.draw_line(line, yy, NAME_SIZE)
                yy -= 9.5

    block(BUYER_BLOCK_Y, BUYER_LINE_Y, "Buyer:", "buyer_date", spec["buyer_signer"])
    if spec.get("buyer2_signer"):
        block(BUYER2_BLOCK_Y, BUYER2_LINE_Y, "Buyer:", "buyer2_date", spec["buyer2_signer"])
    block(SELLER_BLOCK_Y, SELLER_LINE_Y, "Seller:", "seller_date", None)  # the Name field below carries the seller
    yy = SELLER_BLOCK_Y - 22.8
    p.text(LABEL_X, yy, "Name:", REG, SIZE)
    r = (VALUE_X, yy - FIELD_DROP, SIG_X1, yy - FIELD_DROP + FIELD_H)
    p.field_box(r[0], r[1], r[2] - r[0], FIELD_H)
    p.fields.append({"name": "seller_signer_name", "rect": r, "multiline": False, "value": spec["seller_signer"]})

    # Anyone past two buyers and one seller signs e-sign's generated Signature Addendum.
    x0, y0, x1, y1 = CHECKBOX_RECT
    p.field_box(x0, y0, x1 - x0, y1 - y0)
    p.fields.append({"name": "addendum_attached", "rect": CHECKBOX_RECT, "checkbox": True})
    yy = 52.0
    for line in lines_of(tokens("Additional Buyer(s) and/or Seller(s) have signed the attached Signature Addendum, "
                                "which is incorporated into and made a part of this Addendum."), x1 + 4, x1 + 4):
        p.draw_line(line, yy, SIZE)
        yy -= 11.0

    # Hidden marker: tells e-sign this is an LRG addendum (one page, kept off the lead card).
    p.fields.append({"name": "addendum_form", "rect": (0.0, 0.0, 0.0, 0.0), "multiline": False})

    p.footer()
    c.showPage()
    c.save()
    return buf.getvalue(), [p.fields], last


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    with open(sys.argv[1]) as fh:
        spec = json.load(fh)
    pdf, fields_per_page, page1_last = build(spec)
    final = add_form(pdf, fields_per_page)
    with open(sys.argv[2], "wb") as fh:
        fh.write(final)
    print(f"wrote {sys.argv[2]}  ({len(final)} bytes, 1 page, terms end at {page1_last:.1f}pt)")


if __name__ == "__main__":
    main()
