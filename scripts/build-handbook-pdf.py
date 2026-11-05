"""Build docs/AI-SDLC-Copilot-Handbook.pdf from docs/HANDBOOK.md.

Usage:  python scripts/build-handbook-pdf.py
Needs:  pip install reportlab fonttools   (uses Segoe UI / Consolas on Windows, DejaVu on Linux/macOS if present)
Handles the Markdown subset the handbook uses: #/##/### headings, paragraphs, bullet and numbered lists,
tables, fenced code blocks, `code`, **bold** and links.
"""
import os
import re
import sys
from datetime import date
from fontTools.ttLib import TTFont as FTFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageBreak, PageTemplate, Paragraph, Preformatted, Spacer,
                                Table, TableStyle, KeepTogether)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'docs', 'HANDBOOK.md')
OUT = os.path.join(ROOT, 'docs', 'AI-SDLC-Copilot-Handbook.pdf')

FONT_CANDIDATES = {
    'Body': ['C:/Windows/Fonts/segoeui.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/Library/Fonts/Arial Unicode.ttf'],
    'Body-Bold': ['C:/Windows/Fonts/segoeuib.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/Library/Fonts/Arial Bold.ttf'],
    'Mono': ['C:/Windows/Fonts/consola.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/Library/Fonts/Courier New.ttf'],
}
cmaps = {}
for name, paths in FONT_CANDIDATES.items():
    path = next((p for p in paths if os.path.exists(p)), None)
    if not path:
        sys.exit(f'No font found for {name}; edit FONT_CANDIDATES')
    pdfmetrics.registerFont(TTFont(name, path))
    cmaps[name] = set(FTFont(path).getBestCmap().keys())
pdfmetrics.registerFontFamily('Body', normal='Body', bold='Body-Bold', italic='Body', boldItalic='Body-Bold')

# Characters the fonts lack are replaced so nothing renders as a black box.
FALLBACK = {'📎': '[clip]', '✓': 'yes', '✦': '*', '🎭': '', '⚠': '!'}


def safe(text, font='Body'):
    out = []
    for ch in text:
        if ch in FALLBACK:
            out.append(FALLBACK[ch])
        elif ord(ch) < 128 or ord(ch) in cmaps[font]:
            out.append(ch)
        else:
            out.append('?')
    return ''.join(out)


INK, MUTED, ACCENT, RULE, SOFT, CODEBG = (colors.HexColor(c) for c in ('#14212E', '#4A5866', '#0B6E4F', '#D9D4C7', '#EEF4F0', '#F4F2EC'))
S = {
    'title': ParagraphStyle('title', fontName='Body-Bold', fontSize=30, leading=36, textColor=INK),
    'subtitle': ParagraphStyle('subtitle', fontName='Body', fontSize=13, leading=19, textColor=MUTED),
    'h1': ParagraphStyle('h1', fontName='Body-Bold', fontSize=20, leading=25, textColor=INK, spaceBefore=4, spaceAfter=8),
    'h2': ParagraphStyle('h2', fontName='Body-Bold', fontSize=16, leading=21, textColor=ACCENT, spaceBefore=6, spaceAfter=6),
    'h3': ParagraphStyle('h3', fontName='Body-Bold', fontSize=12, leading=16, textColor=INK, spaceBefore=8, spaceAfter=4),
    'body': ParagraphStyle('body', fontName='Body', fontSize=9.5, leading=13.5, textColor=INK, spaceAfter=5, alignment=TA_LEFT),
    'bullet': ParagraphStyle('bullet', fontName='Body', fontSize=9.5, leading=13.5, textColor=INK, leftIndent=14, bulletIndent=3, spaceAfter=2),
    'cell': ParagraphStyle('cell', fontName='Body', fontSize=8, leading=10.5, textColor=INK),
    'cellh': ParagraphStyle('cellh', fontName='Body-Bold', fontSize=8, leading=10.5, textColor=colors.white),
    'code': ParagraphStyle('code', fontName='Mono', fontSize=7.4, leading=9.6, textColor=INK, backColor=CODEBG, borderPadding=6, spaceBefore=4, spaceAfter=8),
    'toc': ParagraphStyle('toc', fontName='Body', fontSize=11, leading=18, textColor=INK),
}


def inline(text):
    """Markdown inline -> reportlab mini-markup."""
    parts = re.split(r'(`[^`]+`)', text)
    out = []
    for p in parts:
        if p.startswith('`') and p.endswith('`') and len(p) > 1:
            code = safe(p[1:-1], 'Mono').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            out.append(f'<font name="Mono" size="8" color="#0B4F3A">{code}</font>')
        else:
            t = safe(p).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
            t = re.sub(r'(https?://[^\s)]+)', r'<link href="\1" color="#1F5FAD">\1</link>', t)
            out.append(t)
    return ''.join(out)


def table(rows, width):
    header, body = rows[0], rows[1:]
    ncol = len(header)
    # Column widths proportional to content length, with a floor so short columns stay readable.
    plain = lambda c: re.sub(r'[`*]', '', c)
    lens = [min(max(max(len(plain(r[i])) if i < len(r) else 0 for r in rows), 6), 60) for i in range(ncol)]
    # Never narrower than the column's longest word (about 4.6 pt per character at 8 pt, plus padding).
    floor = [min(max((len(w) for r in rows if i < len(r) for w in plain(r[i]).split()), default=4), 40) * 4.6 + 10 for i in range(ncol)]
    widths = [width * l / sum(lens) for l in lens]
    for _ in range(5):
        short = [i for i in range(ncol) if widths[i] < floor[i]]
        if not short:
            break
        for i in short:
            widths[i] = floor[i]
        rest = [i for i in range(ncol) if i not in short]
        spare = width - sum(widths[i] for i in short)
        weight = sum(lens[i] for i in rest) or 1
        for i in rest:
            widths[i] = max(floor[i], spare * lens[i] / weight)
    scale = width / sum(widths)
    widths = [w * scale for w in widths]
    data = [[Paragraph(inline(c), S['cellh']) for c in header]]
    for r in body:
        r = (r + [''] * ncol)[:ncol]
        data.append([Paragraph(inline(c), S['cell']) for c in r])
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), ACCENT),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('GRID', (0, 0), (-1, -1), 0.4, RULE),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, SOFT]),
        ('LEFTPADDING', (0, 0), (-1, -1), 4), ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return t


def parse(md, width):
    lines = md.splitlines()
    story, toc = [], []
    i = 0
    para = []

    def flush():
        if para:
            story.append(Paragraph(inline(' '.join(para)), S['body']))
            para.clear()

    while i < len(lines):
        line = lines[i]
        if line.startswith('```'):
            flush()
            block = []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                block.append(safe(lines[i], 'Mono'))
                i += 1
            story.append(Preformatted('\n'.join(block), S['code']))
        elif line.startswith('|'):
            flush()
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split(' | ')]
                cells = [c.strip('|').strip() for c in cells]
                if not re.fullmatch(r'\|[\s:|-]+\|', lines[i].strip()):
                    rows.append(cells)
                i += 1
            story.append(table(rows, width))
            story.append(Spacer(1, 6))
            continue
        elif line.startswith('# '):
            flush()
        elif line.startswith('## '):
            flush()
            title = line[3:].strip()
            toc.append(title)
            if len(toc) > 1:
                story.append(PageBreak())
            story.append(Paragraph(inline(title), S['h1']))
        elif line.startswith('### '):
            flush()
            story.append(KeepTogether([Paragraph(inline(line[4:]), S['h2'])]))
        elif re.match(r'^\s*[-*] ', line):
            flush()
            story.append(Paragraph(inline(re.sub(r'^\s*[-*] ', '', line)), S['bullet'], bulletText='•'))
        elif re.match(r'^\s*\d+\. ', line):
            flush()
            n = re.match(r'^\s*(\d+)\. ', line).group(1)
            story.append(Paragraph(inline(re.sub(r'^\s*\d+\. ', '', line)), S['bullet'], bulletText=f'{n}.'))
        elif not line.strip():
            flush()
        else:
            para.append(line.strip())
        i += 1
    flush()
    return story, toc


def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont('Body', 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 12 * mm, 'AI SDLC Copilot · Team Handbook')
    canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, f'Page {doc.page}')
    canvas.setStrokeColor(RULE)
    canvas.line(18 * mm, 16 * mm, A4[0] - 18 * mm, 16 * mm)
    canvas.restoreState()


def on_cover(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(colors.HexColor('#0F1E2B'))
    canvas.rect(0, A4[1] - 95 * mm, A4[0], 95 * mm, fill=1, stroke=0)
    canvas.setFillColor(colors.HexColor('#2FC48D'))
    canvas.rect(18 * mm, A4[1] - 97 * mm, 40 * mm, 2 * mm, fill=1, stroke=0)
    canvas.restoreState()


def main():
    md = open(SRC, encoding='utf-8').read()
    doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm, bottomMargin=22 * mm,
                          title='AI SDLC Copilot - Team Handbook', author='AI SDLC Copilot team', subject='Handbook for BA, Developer and QA')
    width = doc.width
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='f')
    cover_frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height - 20 * mm, id='c')
    doc.addPageTemplates([PageTemplate('cover', [cover_frame], onPage=on_cover), PageTemplate('body', [frame], onPage=on_page)])

    body, toc = parse(md, width)
    intro = md.split('\n## ')[0].splitlines()[1:]
    intro_text = [l for l in intro if l.strip()]
    white = ParagraphStyle('w', parent=S['title'], textColor=colors.HexColor('#F3F0E8'))
    whitesub = ParagraphStyle('ws', parent=S['subtitle'], textColor=colors.HexColor('#C9D4DC'))
    story = [Spacer(1, 18 * mm), Paragraph('AI SDLC Copilot', white), Spacer(1, 4),
             Paragraph('Team Handbook for Business Analysts, Developers and QA', whitesub), Spacer(1, 2),
             Paragraph(f'FY27 NFTS Code-a-thon · Use Case 2 · {date.today():%d %B %Y}', whitesub), Spacer(1, 30 * mm)]
    for l in intro_text:
        story.append(Paragraph(inline(l), S['body']))
    story += [Spacer(1, 8 * mm), Paragraph('Contents', S['h2'])]
    for n, t in enumerate(toc, 1):
        story.append(Paragraph(inline(t), S['toc']))
    from reportlab.platypus import NextPageTemplate
    story += [NextPageTemplate('body'), PageBreak()]
    # First H2 in body starts without a page break; drop the leading PageBreak logic handled in parse.
    story += body
    doc.build(story)
    print(f'Wrote {os.path.relpath(OUT, ROOT)}')


if __name__ == '__main__':
    main()
