#!/usr/bin/env python3
"""Generate the synthetic figure PDF fixture for the #807 real-Docling Reader contract.

Produces a single-page PDF that carries BOTH body text and an embedded raster image, so the pinned
Docling layout model classifies the image region as a `PictureItem` (which the worker then renders to a
PNG artifact). The image is a deterministic RGB gradient encoded as a baseline JPEG (DCTDecode) so the
PDF stays small and self-contained. Hand-written xref, mirroring the existing tests/fixtures/structured
PDFs, so no PDF library is required at fixture-build time.

Usage: python make_figure_pdf.py <out.pdf>
"""
import io
import struct
import sys
import zlib

from PIL import Image


def build_image_jpeg(width: int, height: int) -> bytes:
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            pixels[x, y] = ((x * 255) // width, (y * 255) // height, ((x + y) * 127) // (width + height))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


def build_pdf(out_path: str) -> None:
    img_w, img_h = 240, 180
    jpeg = build_image_jpeg(img_w, img_h)

    # Draw the image in a clearly bounded rectangle in the page's upper half, with a heading above and a
    # paragraph below, so the layout model sees text + a distinct picture region.
    content = (
        "BT /F1 18 Tf 72 720 Td (Figure demonstration document) Tj ET\n"
        "BT /F1 12 Tf 72 300 Td (The gradient above is an embedded raster figure extracted by the pipeline.) Tj ET\n"
        f"q 300 0 0 225 156 430 cm /Im0 Do Q\n"
    ).encode("latin-1")

    objects: list[bytes] = []

    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objects.append(
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> "
        b"/Contents 4 0 R >>"
    )
    objects.append(
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"\nendstream"
    )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    objects.append(
        b"<< /Type /XObject /Subtype /Image /Width " + str(img_w).encode("ascii") +
        b" /Height " + str(img_h).encode("ascii") +
        b" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " +
        str(len(jpeg)).encode("ascii") + b" >>\nstream\n" + jpeg + b"\nendstream"
    )

    out = bytearray()
    out += b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    offsets = [0]
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(index).encode("ascii") + b" 0 obj\n" + body + b"\nendobj\n"

    xref_pos = len(out)
    count = len(objects) + 1
    out += b"xref\n0 " + str(count).encode("ascii") + b"\n"
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += ("%010d 00000 n \n" % offset).encode("ascii")
    out += b"trailer\n<< /Size " + str(count).encode("ascii") + b" /Root 1 0 R >>\n"
    out += b"startxref\n" + str(xref_pos).encode("ascii") + b"\n%%EOF\n"

    with open(out_path, "wb") as handle:
        handle.write(out)


if __name__ == "__main__":
    build_pdf(sys.argv[1])
    print("wrote", sys.argv[1])
