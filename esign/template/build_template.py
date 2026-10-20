#!/usr/bin/env python3
"""
Build the LRG Homes Real Estate Purchase & Sale Agreement template PDF.

    python3 esign/template/build_template.py            # writes esign/assets/template-reference.pdf
    python3 esign/template/build_template.py OUT.pdf    # writes somewhere else

ReportLab draws the two letter pages (text, the light-blue field boxes, the
signature lines, the footer) and pypdf adds the AcroForm: 15 text fields
(the 13 the offer bot fills — briefs/OFFER_BOT.md — plus expiration_date and
expiration_days) and the addendum_attached checkbox + addendum_names text.

This reproduces the one-off 2026-10-15 document line for line, plus the
2026-10-20 changes (briefs/ESIGN_V2.md): term 4 Expiration (old 4–22 are now
5–23, the two cross-references moved with them), and the "Additional
Seller(s) / Buyer(s)" checkbox line under the Seller block on page 2. Body
leading is 11.4pt (was 12) and the gap between terms 3pt (was 4) so page 1
absorbs the new term; page 2 keeps the original 12pt/4pt and everything from
the stipulations box down is anchored at its original coordinates, so the
signature lines e-sign draws on (esign/lib/pdf.mjs TEMPLATE) did not move.

Geometry is in PDF points, origin bottom-left. The script prints the field
rectangles and the coordinates e-sign needs when it finishes.
"""
import io
import os
import re
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    StreamObject,
    TextStringObject,
)
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "assets", "template-reference.pdf"))

W, H = 612.0, 792.0
LEFT, RIGHT = 54.0, 558.0          # text column
INDENT = 67.0                      # continuation lines of a numbered term
BODY = 9.4                         # body size (Helvetica)
LEAD = 11.4                        # page-1 body leading (the 2026-10-15 document used 12)
GAP = 3.0                          # page-1 extra space between terms (was 4)
LEAD2, GAP2 = 12.0, 4.0            # page 2 keeps the original leading so nothing below the terms moves
FIELD_H = 12.0                     # text field height
FIELD_DROP = 3.0                   # field bottom sits this far below the baseline
BLUE = (0.9, 0.94, 1.0)            # the light-blue box, page content and widget alike
REG, BOLD, ITAL = "Helvetica", "Helvetica-Bold", "Helvetica-Oblique"

TITLE = "REAL ESTATE PURCHASE & SALE AGREEMENT"
FOOTER = "Real Estate Purchase & Sale Agreement  |  Page {n}"

# ---------------------------------------------------------------- content
# Inline markup: {field:NAME:WIDTH} is a text field box; **bold** is bold.

PREAMBLE = (
    "This Real Estate Purchase & Sale Agreement is entered into this {field:agreement_date:95} [date] between "
    "{field:seller_name:200} (\"Seller\"), its heirs, executors, administrators, personal representatives, "
    "successors, and **LRG Homes, LLC** (\"Buyer\"), or assigns regarding the purchase of property described as: "
    "{field:property_address:300} (\"Property\"). Built-in appliances, structural, foundation, roof, plumbing, "
    "heating, air conditioning, electrical, mechanical, security, pool/spa systems and components, and any fixtures "
    "are included in the sale."
)

TERMS = [
    ("Purchase Price.", "The Seller agrees to convey the Property to Buyer for the sum of: $ {field:purchase_price:120} ."),
    ("Closing.", "Closing shall occur as soon as possible and no later than {field:closing_days:32} days from acceptance at a "
                 "time and place designated by Buyer's choice of escrow, title and/or Closing agent. Time is expressly declared "
                 "to be of the essence of this Agreement except as provided in para. 6. Buyer shall pay all closing costs except "
                 "for transfer tax (if existing). Closing to be held at: Chicago Title Company. Escrow Company's contact "
                 "information: Phone: (408) 354-6737."),
    ("Earnest money.", "Buyer shall deliver an earnest money deposit in the amount of $ {field:earnest_money:85} to Escrow "
                       "Company prior to Closing."),
    ("Expiration.", "This offer shall be deemed revoked and any earnest money deposit returned to Buyer unless this Agreement "
                    "is signed by Seller and a signed copy is delivered to Buyer by 5:00 p.m. Pacific time on "
                    "{field:expiration_date:95} (the \"Expiration Date\"). If no Expiration Date is entered, this offer expires "
                    "at 5:00 p.m. Pacific time on the {field:expiration_days:32} calendar day after the date Buyer signs this "
                    "Agreement."),
    ("Prorations.", "Real property taxes and assessments, interest, rents, homeowners' association regular dues and regular "
                    "assessments, premiums on insurance assumed by Buyer, payments on bonds and assessments assumed by Buyer "
                    "shall be paid current by Seller from the proceeds of sale (if needed) and prorated between Buyer and Seller "
                    "as of the Close of Escrow."),
    ("Buyer's Extensions.", "Seller grants Buyer any extension as needed to address any defects in title or property conditions "
                            "that may be discovered by Buyer after this Agreement is signed."),
    ("Contingencies.", "This Agreement is contingent upon Buyer's satisfactory inspection and approval of title and of the "
                       "physical condition of the Property before Closing."),
    ("Examination of Title.", "Buyer shall be provided a current preliminary title report at Buyer's expense. Title shall be free "
                              "of liens, encumbrances, easements, restrictions, rights and conditions of record or known to "
                              "Seller, except for all matters shown in the preliminary title report which are not disapproved in "
                              "writing by Buyer."),
    ("Property Inspections and Access.", "Buyer shall have the right to conduct inspections, investigations, tests, surveys, "
                                         "and other studies (\"Buyer's Inspections\") at Buyer's expense. Access to property "
                                         "also shall be granted to Buyer - including Buyer's partners, contractors, property "
                                         "inspectors, and lenders - with a key (if vacant). Property is sold \"AS IS,\" in its "
                                         "present condition, without warranty. Seller shall not be responsible for making "
                                         "corrections or repairs of any nature. Buyer retains the right to disapprove the "
                                         "condition of the Property based upon items discovered in Buyer's Inspections."),
    ("Cancellation.", "Buyer shall have the right to cancel this Agreement prior to Closing if title and/or the physical "
                      "condition of the Property is not satisfactory to Buyer. Buyer will notify the Seller about cancellation "
                      "in writing. Seller agrees to sign a mutual release and cancellation instructions authorizing the return "
                      "of the earnest money deposit to Buyer."),
    ("Possession and Keys.", "Seller shall deliver possession and occupancy of the Property to Buyer on the date of "
                             "recordation of the deed at 5:00 p.m. Property shall be vacant unless otherwise agreed in "
                             "writing. Seller shall provide keys and/or means to operate all property locks, mailboxes, "
                             "security systems, alarms, garage door openers, and homeowners' association facilities, if any. "
                             "Any personal items, furniture, or debris will be removed from the Property prior to Closing "
                             "except as agreed below."),
    ("Buyer Marketing.", "Seller grants Buyer the right to market the property to potential investors or buyers on social "
                         "media, and other online and offline platforms by owner."),
    ("Final Inspection.", "Buyer shall have the right to make a final inspection of the Property approximately two (2) "
                          "calendar days prior to Close of Escrow to confirm that the Property is otherwise in substantially "
                          "the same condition as on the date this Agreement is signed."),
    ("Solar / Energy System.", "If the Property is subject to any solar lease, power purchase agreement (PPA), financing, "
                               "UCC filing, or other third-party agreement relating to solar panels or energy systems, Seller "
                               "shall be solely responsible for all obligations thereunder through Closing. At Buyer's "
                               "election, Seller shall either (i) pay off such agreement prior to or at Closing, or (ii) "
                               "authorize Escrow to deduct any required payoff from Seller's proceeds to release any related "
                               "lien or encumbrance. Buyer shall not be required to assume any such agreement unless agreed "
                               "to in writing."),
    ("Risk of Loss.", "All risk of loss to the Property which occurs after the offer is accepted shall be borne by Seller "
                      "until either the title has been transferred, or possession has been given to Buyer, whichever occurs "
                      "first."),
    # ---- page 2
    ("Remedies.", "If Seller fails or refuses to perform Seller's obligations under this Agreement, including conveying title "
                  "and transferring possession to Buyer, Buyer may either: (a) cancel the Agreement and recover all deposits "
                  "and other amounts paid by Buyer under this Agreement, and all expenses paid or incurred; or (b) pursue any "
                  "available remedies at law or in equity, including an action to compel specific performance of this "
                  "Agreement, or one for damages for breach, separately or alternatively. If the Buyer breaches any "
                  "obligation under this Agreement, Seller shall retain, as liquidated damages for breach of contract, the "
                  "deposit actually paid. Cancellation pursuant to para. 10 is not a breach by Buyer. In any action or legal "
                  "proceeding between Buyer and Seller arising out of this Agreement, the prevailing party shall be entitled "
                  "to reasonable attorney's fees and costs."),
    ("Assignability.", "Buyer has an unqualified right to assign its rights under this contract to a third party. No notice "
                       "to the Seller of an assignment is necessary. Such an assignment will create a novation and release "
                       "the original Buyer from this contract and substitute the assignee in its place."),
    ("Applicable Law.", "The state laws of {field:governing_state:110} shall govern this Agreement and the parties with "
                        "respect to any disputes if they arise."),
    ("Severability.", "In the event that any one or more of the provisions contained herein, or the application thereof in "
                      "any circumstances, is held invalid, illegal or unenforceable, the validity, legality and "
                      "enforceability of any such provision in every other respect and of the remaining provisions contained "
                      "herein shall not be affected or impaired thereby."),
    ("Buyer's Settlement Statement.", "Seller authorizes the Escrow Company to provide Buyer with a copy of Seller's "
                                      "settlement statement."),
    ("Entire Contract; Changes.", "All prior agreements between the parties are incorporated in this Agreement which "
                                  "constitutes the entire contract. Its terms are intended by the parties as a final, complete "
                                  "and exclusive expression of their agreement with respect to its subject matter and may not "
                                  "be contradicted by evidence of any prior agreement or contemporaneous oral agreement. The "
                                  "captions in this Agreement are for convenience of reference only and are not intended as "
                                  "part of this Agreement. This Agreement may not be extended, amended, modified, altered, or "
                                  "changed in any respect whatsoever except by a further agreement in writing signed by Buyer "
                                  "and Seller."),
    ("Disclosures.", "Buyer is a real estate investment company that may enter into an agreement to resell this property "
                     "for a profit, before or after Closing."),
    ("SPECIAL STIPULATIONS:", ""),
]
PAGE2_FIRST_TERM = 16  # 1-based number of the first term on page 2 ("Remedies")

ADDENDUM_LINE = "Additional Seller(s) / Buyer(s) sign on the attached Signature Addendum, which is part of this Agreement."

# Anchored page-2 geometry (unchanged from the 2026-10-15 document).
STIPS_RECT = (67.0, 335.0, 558.0, 395.0)
BUYER_BLOCK_Y = 306.0             # "Dated:" / "Buyer:" baseline
BUYER_LINE_Y = 280.2              # buyer signature line
SELLER_BLOCK_Y = 203.8            # "Dated:" / "Seller:" baseline
SELLER_LINE_Y = 200.8             # seller signature line
SIG_X0, SIG_X1 = 309.0, 558.0     # signature lines
LABEL_X, VALUE_X = 269.0, 309.0   # Name:/Tel:/Email: labels and values
ROW = 16.2                        # label row spacing in the signature blocks
CHECKBOX_RECT = (54.0, 124.0, 64.0, 134.0)
ADDENDUM_TEXT_Y = 128.0           # baseline of the checkbox sentence
NAMES_Y = 112.0                   # baseline of "Names:"
NAMES_RECT = (100.0, NAMES_Y - FIELD_DROP, 558.0, NAMES_Y - FIELD_DROP + FIELD_H)


# ---------------------------------------------------------------- layout

FIELD_RE = re.compile(r"\{field:([a-z_]+):(\d+(?:\.\d+)?)\}")


def tokens(markup, font=REG):
    """'a **b c** {field:x:95} d' → [(text|field, ...)] one word per token."""
    out = []
    for chunk in re.split(r"(\*\*.*?\*\*)", markup):
        if not chunk:
            continue
        f = font
        if chunk.startswith("**") and chunk.endswith("**"):
            chunk, f = chunk[2:-2], BOLD
        for word in chunk.split(" "):
            if not word:
                continue
            m = FIELD_RE.fullmatch(word)
            out.append(("field", m.group(1), float(m.group(2))) if m else ("text", word, f))
    return out


def width(tok, size=BODY):
    return tok[2] if tok[0] == "field" else stringWidth(tok[1], tok[2], size)


def wrap(toks, x_first, x_cont, x_max=RIGHT, size=BODY):
    """Greedy word wrap → list of lines, each [(x, token), …]."""
    space = stringWidth(" ", REG, size)
    lines, cur, x = [], [], x_first
    for t in toks:
        w = width(t, size)
        if cur and x + w > x_max + 0.01:
            lines.append(cur)
            cur, x = [], x_cont
        cur.append((x, t))
        x += w + space
    if cur:
        lines.append(cur)
    return lines


class Page:
    def __init__(self, c, number):
        self.c, self.number, self.fields = c, number, []

    def field_box(self, x, y, w, h):
        """The light-blue box in the page content (the widget sits on top)."""
        c = self.c
        c.setFillColorRGB(*BLUE)
        c.setStrokeColorRGB(0, 0, 0)
        c.setLineWidth(0.6)
        c.rect(x + 0.3, y + 0.3, w - 0.6, h - 0.6, stroke=1, fill=1)
        c.setFillColorRGB(0, 0, 0)

    def draw_line(self, line, baseline, size=BODY):
        for x, t in line:
            if t[0] == "field":
                rect = (x, baseline - FIELD_DROP, x + t[2], baseline - FIELD_DROP + FIELD_H)
                self.field_box(rect[0], rect[1], t[2], FIELD_H)
                self.fields.append({"name": t[1], "rect": rect, "multiline": False})
            else:
                self.c.setFont(t[2], size)
                self.c.drawString(x, baseline, t[1])

    def text(self, x, y, s, font=REG, size=BODY):
        self.c.setFont(font, size)
        self.c.drawString(x, y, s)

    def centered(self, y, s, font, size):
        self.text((W - stringWidth(s, font, size)) / 2, y, s, font, size)

    def footer(self):
        self.c.setFillColorRGB(0.5, 0.5, 0.5)
        self.centered(30.0, FOOTER.format(n=self.number), REG, 7.5)
        self.c.setFillColorRGB(0, 0, 0)


def term_tokens(n, heading, body):
    return [("text", f"{n}.", REG), ("text", heading, BOLD)] + tokens(body)


def draw_terms(page, y, numbered, lead=LEAD, gap=GAP):
    """Lay out numbered terms from baseline y downwards; returns the next baseline."""
    for n, heading, body in numbered:
        lines = wrap(term_tokens(n, heading, body), LEFT, INDENT)
        for line in lines:
            page.draw_line(line, y)
            y -= lead
        y -= gap
    return y


def build_pages():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(W, H))
    c.setTitle("Real Estate Purchase & Sale Agreement")
    c.setAuthor("LRG Homes")
    c.setCreator("esign/template/build_template.py")
    pages = []

    # ---- page 1
    p = Page(c, 1)
    p.centered(742.0, TITLE, BOLD, 14)
    y = 718.0
    for line in wrap(tokens(PREAMBLE), LEFT, LEFT):
        p.draw_line(line, y)
        y -= LEAD
    y += LEAD
    y -= 20.0
    p.centered(y, "TERMS", BOLD, 11)
    y -= 17.0
    numbered = [(i + 1, h, b) for i, (h, b) in enumerate(TERMS)]
    y = draw_terms(p, y, numbered[: PAGE2_FIRST_TERM - 1])
    page1_last_baseline = y + GAP + LEAD
    p.footer()
    pages.append(p)
    c.showPage()

    # ---- page 2
    p = Page(c, 2)
    y = draw_terms(p, 742.0, numbered[PAGE2_FIRST_TERM - 1:], LEAD2, GAP2)
    page2_terms_end = y + GAP2 + LEAD2
    x0, y0, x1, y1 = STIPS_RECT
    p.field_box(x0, y0, x1 - x0, y1 - y0)
    p.fields.append({"name": "special_stipulations", "rect": STIPS_RECT, "multiline": True})
    for f in p.fields:
        if f["name"] == "governing_state":
            f["value"] = "California"  # pre-filled, as in the 2026-10-15 document

    # Buyer block
    p.text(LEFT, BUYER_BLOCK_Y, "Dated:")
    r = (88.0, BUYER_BLOCK_Y - FIELD_DROP, 198.0, BUYER_BLOCK_Y - FIELD_DROP + FIELD_H)
    p.field_box(r[0], r[1], r[2] - r[0], FIELD_H)
    p.fields.append({"name": "buyer_date", "rect": r, "multiline": False})
    p.text(LABEL_X, BUYER_BLOCK_Y, "Buyer:")
    p.text(VALUE_X, BUYER_BLOCK_Y, "LRG Homes, LLC", BOLD)
    p.text(VALUE_X + stringWidth("LRG Homes, LLC", BOLD, BODY), BUYER_BLOCK_Y, ", by its authorized representative")
    c.setLineWidth(0.6)
    c.setStrokeColorRGB(0, 0, 0)
    c.line(SIG_X0, BUYER_LINE_Y, SIG_X1, BUYER_LINE_Y)
    p.text(SIG_X0 + 2, BUYER_LINE_Y - 8.0, "Signature", ITAL, 7)
    yy = BUYER_BLOCK_Y - 45.6
    for label, value in (("Name:", "Ryan LaRocca"), ("Tel:", "(408) 500-6293"), ("Email:", "ryan@lrghomes.com")):
        p.text(LABEL_X, yy, label)
        p.text(VALUE_X, yy, value)
        yy -= ROW

    # Seller block
    p.text(LEFT, SELLER_BLOCK_Y, "Dated:")
    r = (88.0, SELLER_BLOCK_Y - FIELD_DROP, 198.0, SELLER_BLOCK_Y - FIELD_DROP + FIELD_H)
    p.field_box(r[0], r[1], r[2] - r[0], FIELD_H)
    p.fields.append({"name": "seller_date", "rect": r, "multiline": False})
    p.text(LABEL_X, SELLER_BLOCK_Y, "Seller:")
    c.line(SIG_X0, SELLER_LINE_Y, SIG_X1, SELLER_LINE_Y)
    p.text(SIG_X0 + 2, SELLER_LINE_Y - 8.0, "Signature", ITAL, 7)
    yy = SELLER_BLOCK_Y - 22.8
    for label, name in (("Name:", "seller_signer_name"), ("Tel:", "seller_tel"), ("Email:", "seller_email")):
        p.text(LABEL_X, yy, label)
        r = (VALUE_X, yy - FIELD_DROP, SIG_X1, yy - FIELD_DROP + FIELD_H)
        p.field_box(r[0], r[1], r[2] - r[0], FIELD_H)
        p.fields.append({"name": name, "rect": r, "multiline": False})
        yy -= ROW

    # Additional signers line (ticked + filled by e-sign when the envelope has addendum signers)
    x0, y0, x1, y1 = CHECKBOX_RECT
    p.field_box(x0, y0, x1 - x0, y1 - y0)
    p.fields.append({"name": "addendum_attached", "rect": CHECKBOX_RECT, "checkbox": True})
    p.text(x1 + 4, ADDENDUM_TEXT_Y, ADDENDUM_LINE)
    p.text(x1 + 4, NAMES_Y, "Names:")
    x0, y0, x1, y1 = NAMES_RECT
    p.field_box(x0, y0, x1 - x0, y1 - y0)
    p.fields.append({"name": "addendum_names", "rect": NAMES_RECT, "multiline": False})

    p.footer()
    pages.append(p)
    c.showPage()
    c.save()
    return buf.getvalue(), [pg.fields for pg in pages], {"page1_last_baseline": page1_last_baseline, "page2_terms_end": page2_terms_end}


# ---------------------------------------------------------------- AcroForm

def xobject(writer, bbox, data, font_ref=None):
    s = StreamObject()
    s[NameObject("/Type")] = NameObject("/XObject")
    s[NameObject("/Subtype")] = NameObject("/Form")
    s[NameObject("/BBox")] = ArrayObject([FloatObject(v) for v in bbox])
    res = DictionaryObject({NameObject("/ProcSet"): ArrayObject([NameObject("/PDF"), NameObject("/Text")])})
    if font_ref is not None:
        res[NameObject("/Font")] = DictionaryObject({NameObject("/Helv"): font_ref})
    s[NameObject("/Resources")] = res
    s._data = data.encode("latin-1")
    return writer._add_object(s)


def add_form(pdf_bytes, fields_per_page):
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    writer.append(reader)
    helv = writer._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"), NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
    }))
    zadb = writer._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/ZapfDingbats"),
    }))
    field_refs = ArrayObject()
    for page, fields in zip(writer.pages, fields_per_page):
        annots = page.get("/Annots")
        if annots is None:
            annots = ArrayObject()
            page[NameObject("/Annots")] = annots
        for f in fields:
            x0, y0, x1, y1 = f["rect"]
            w, h = x1 - x0, y1 - y0
            a = DictionaryObject({
                NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"),
                NameObject("/T"): TextStringObject(f["name"]), NameObject("/F"): NumberObject(4),
                NameObject("/Rect"): ArrayObject([FloatObject(v) for v in f["rect"]]),
                NameObject("/P"): page.indirect_reference,
                NameObject("/MK"): DictionaryObject({
                    NameObject("/BC"): ArrayObject([NumberObject(0)] * 3),
                    NameObject("/BG"): ArrayObject([FloatObject(v) for v in BLUE]),
                }),
            })
            if f.get("checkbox"):
                box = f".9 .94 1 rg 0 0 {w} {h} re f 0 0 0 RG 0.6 w 0.3 0.3 {w - 0.6} {h - 0.6} re S\n"
                tick = f"0 G 1.1 w 1 J 1 j {w * 0.22} {h * 0.5} m {w * 0.42} {h * 0.25} l {w * 0.8} {h * 0.78} l S\n"
                a.update({
                    NameObject("/FT"): NameObject("/Btn"), NameObject("/Ff"): NumberObject(0),
                    NameObject("/V"): NameObject("/Off"), NameObject("/AS"): NameObject("/Off"),
                    NameObject("/DA"): TextStringObject("/ZaDb 0 Tf 0 g"),
                    NameObject("/BS"): DictionaryObject({NameObject("/S"): NameObject("/S"), NameObject("/W"): FloatObject(0.6)}),
                    NameObject("/AP"): DictionaryObject({NameObject("/N"): DictionaryObject({
                        NameObject("/Off"): xobject(writer, (0, 0, w, h), box),
                        NameObject("/Yes"): xobject(writer, (0, 0, w, h), box + tick),
                    })}),
                })
                a["/MK"][NameObject("/CA")] = TextStringObject("4")
            else:
                value = f.get("value", "")
                ap = f".9 .94 1 rg 0 0 {w} {h} re f 0 0 0 RG 0.6 w 0 0.3 m {w} 0.3 l s\n/Tx BMC q 1.2 1.2 {w - 2.4} {h - 2.4} re W n "
                if value:
                    ap += f"BT /Helv 9 Tf 0 g 2.4 1.8 Td ({value}) Tj ET "
                ap += "Q EMC\n"
                a.update({
                    NameObject("/FT"): NameObject("/Tx"), NameObject("/Ff"): NumberObject(4096 if f.get("multiline") else 0),
                    NameObject("/V"): TextStringObject(value), NameObject("/DV"): TextStringObject(value),
                    NameObject("/DA"): TextStringObject("/Helv 9 Tf 0 0 0 rg"),
                    NameObject("/BS"): DictionaryObject({NameObject("/S"): NameObject("/U"), NameObject("/W"): FloatObject(0.6)}),
                    NameObject("/AP"): DictionaryObject({NameObject("/N"): xobject(writer, (0, 0, w, h), ap, helv)}),
                })
            ref = writer._add_object(a)
            annots.append(ref)
            field_refs.append(ref)
    acro = DictionaryObject({
        NameObject("/Fields"): field_refs,
        NameObject("/DA"): TextStringObject("/Helv 0 Tf 0 g"),
        NameObject("/DR"): DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/Helv"): helv, NameObject("/ZaDb"): zadb})}),
    })
    writer._root_object[NameObject("/AcroForm")] = writer._add_object(acro)
    writer.add_metadata({"/Title": "Real Estate Purchase & Sale Agreement", "/Author": "LRG Homes", "/Creator": "esign/template/build_template.py"})
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


# ---------------------------------------------------------------- main

def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    pdf, fields_per_page, info = build_pages()
    final = add_form(pdf, fields_per_page)
    with open(out_path, "wb") as fh:
        fh.write(final)

    names = [f["name"] for fields in fields_per_page for f in fields]
    assert len(names) == len(set(names)), "duplicate field names"
    r = PdfReader(io.BytesIO(final))
    assert len(r.pages) == 2, f"expected 2 pages, got {len(r.pages)}"
    assert info["page1_last_baseline"] > 40, f"page 1 overflows the footer (last baseline {info['page1_last_baseline']:.2f})"

    print(f"wrote {out_path}  ({len(final)} bytes, {len(names)} fields, 2 pages)")
    print(f"page 1 last baseline {info['page1_last_baseline']:.2f}pt; page 2 terms end at {info['page2_terms_end']:.2f}pt (stipulations heading)")
    print("\nfields (PDF points, origin bottom-left; page, name, x0 y0 x1 y1):")
    for pi, fields in enumerate(fields_per_page, 1):
        for f in fields:
            x0, y0, x1, y1 = f["rect"]
            kind = "checkbox" if f.get("checkbox") else ("multiline" if f.get("multiline") else "text")
            print(f"  {pi}  {f['name']:<22} {x0:7.2f} {y0:7.2f} {x1:7.2f} {y1:7.2f}   {x1 - x0:.0f}x{y1 - y0:.0f}  {kind}")
    print("\ne-sign (esign/lib/pdf.mjs TEMPLATE, page index 1 = page 2):")
    print(f"  buyer signature line   x {SIG_X0:.0f}–{SIG_X1:.0f}  y {BUYER_LINE_Y}")
    print(f"  seller signature line  x {SIG_X0:.0f}–{SIG_X1:.0f}  y {SELLER_LINE_Y}")
    print(f"  addendum_attached box  {CHECKBOX_RECT}")
    print(f"  addendum_names field   {NAMES_RECT}")


if __name__ == "__main__":
    main()
